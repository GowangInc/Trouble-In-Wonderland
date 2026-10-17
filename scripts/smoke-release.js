import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function assert(value, message) { if (!value) throw new Error(message); }
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function run(command, env = process.env) {
  const result = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "inherit" });
  assert(result.exitCode === 0 && !result.error, `${command[0]} failed (${result.exitCode})`);
  return result.stdout.toString().trim();
}
const [argument, ...extra] = process.argv.slice(2);
assert(argument && !extra.length, "Usage: bun scripts/smoke-release.js <release.zip>");
assert(Bun.version === "1.4.3", "Use the real Bun 1.4.3 CLI for release smoke");
const archive = resolve(argument);
assert(archive.endsWith(".zip"), "Expected a ZIP archive");
const checksum = (await readFile(`${archive}.sha256`, "utf8")).trim().split(/\s+/);
assert(checksum.length === 2 && checksum[1] === basename(archive) && /^[a-f0-9]{64}$/.test(checksum[0]), "Malformed checksum file");
assert(hash(await readFile(archive)) === checksum[0], "ZIP SHA256 mismatch");
const name = basename(archive, ".zip");
assert(/^wonderland-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-(?:linux-x64|windows-x64|macos-universal)$/.test(name), "Unexpected package name");
const windows = process.platform === "win32";
const env = { ...process.env, WONDERLAND_ARCHIVE: archive };
let entries;
if (windows) {
  entries = JSON.parse(run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead($env:WONDERLAND_ARCHIVE); try { ConvertTo-Json -Compress -InputObject @($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() }'], env));
} else entries = run(["unzip", "-Z1", archive]).split(/\r?\n/);
assert(entries.length > 0, "ZIP is empty");
const folded = new Set();
for (const entry of entries) {
  const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  assert(/^[A-Za-z0-9_. /-]+$/.test(path) && path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".")), `Unsafe ZIP entry: ${entry}`);
  assert(path === name || path.startsWith(`${name}/`), `Unexpected ZIP root: ${entry}`);
  assert(!folded.has(path.toLowerCase()), `Duplicate/case-colliding ZIP entry: ${entry}`);
  folded.add(path.toLowerCase());
}
const work = await mkdtemp(join(tmpdir(), "wonderland-native-smoke-"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(relative(repo, work).startsWith(".."), "Smoke workspace must be outside the checkout");
console.log(`Native smoke workspace (retained): ${work}`);
if (windows) run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:WONDERLAND_ARCHIVE -DestinationPath $env:WONDERLAND_EXTRACT'], { ...env, WONDERLAND_EXTRACT: work });
else run(["unzip", "-q", archive, "-d", work]);
const bundle = join(work, name);
const files = [];
async function inventory(directory, prefix = "") {
  for (const entry of await readdir(directory)) {
    const path = prefix + entry;
    const info = await lstat(join(directory, entry));
    assert(!info.isSymbolicLink(), `ZIP contains a symlink: ${path}`);
    if (info.isDirectory()) await inventory(join(directory, entry), `${path}/`);
    else { assert(info.isFile(), `ZIP contains a special file: ${path}`); files.push(path); }
  }
}
await inventory(bundle);
const manifest = JSON.parse(await readFile(join(bundle, "release-manifest.json"), "utf8"));
assert(manifest.schema === 1 && manifest.bun === "1.4.3", "Unsupported manifest/runtime");
assert(manifest.questions?.count === 500 && manifest.questions?.chapters === 12, "Incomplete embedded question bank");
assert(name === `wonderland-${manifest.version}-${manifest.platform}-${manifest.platform === "macos" ? "universal" : "x64"}`, "Manifest and archive identity differ");
assert(manifest.platform === ({ linux: "linux", win32: "windows", darwin: "macos" })[process.platform], "Smoke must run on the package's native OS");
assert(["x64", "arm64"].includes(process.arch) && (manifest.platform === "macos" || process.arch === "x64"), "Unsupported native architecture");
const expectedExecutables = manifest.platform === "macos" ? [["wonderland-arm64", "arm64"], ["wonderland-x64", "x64"]] : [[windows ? "wonderland.exe" : "wonderland", "x64"]];
assert(manifest.executables.length === expectedExecutables.length && expectedExecutables.every(([path, arch]) => manifest.executables.some(item => item.path === path && item.arch === arch)), "Unexpected executable inventory");
const launcher = manifest.platform === "macos" ? "Start Wonderland.command" : windows ? "Start Wonderland.cmd" : "start-wonderland.sh";
assert(manifest.launcher === launcher, "Unexpected launcher");
const allowed = new Set(["README.md", "START-HERE.txt", "release-manifest.json", "licenses/Bun-LICENSE.md", "licenses/qrcode-generator.LICENSE.txt", launcher, ...expectedExecutables.map(([path]) => path)]);
assert(files.length === allowed.size && files.every(path => allowed.has(path)), "Unexpected/missing files in release ZIP");
for (const path of ["README.md", "START-HERE.txt", "licenses/Bun-LICENSE.md", "licenses/qrcode-generator.LICENSE.txt"]) assert((await readFile(join(bundle, path))).length > 100, `Missing/empty required documentation: ${path}`);
for (const executable of manifest.executables) {
  const path = join(bundle, executable.path);
  const bytes = await readFile(path);
  assert(hash(bytes) === executable.sha256, `Executable hash mismatch: ${executable.path}`);
  if (manifest.platform === "macos") {
    const arch = executable.arch === "arm64" ? "arm64" : "x86_64";
    assert(run(["lipo", "-archs", path]) === arch, `Wrong Mach-O architecture: ${executable.path}`);
  } else if (windows) {
    assert(bytes.toString("ascii", 0, 2) === "MZ", "Not a PE executable");
    const offset = bytes.readUInt32LE(0x3c);
    assert(bytes.toString("ascii", offset, offset + 4) === "PE\0\0" && bytes.readUInt16LE(offset + 4) === 0x8664, "Not a Windows x64 executable");
  } else assert(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes.readUInt16LE(18) === 62, "Not a Linux x64 ELF executable");
  if (!windows) assert(((await lstat(path)).mode & 0o111) !== 0, "ZIP lost executable permissions");
}
if (!windows) assert(((await lstat(join(bundle, launcher))).mode & 0o111) !== 0, "ZIP lost launcher permissions");
assert(Array.isArray(manifest.assets) && manifest.assets.some(asset => asset.path.endsWith(".png")) && manifest.assets.some(asset => asset.path.endsWith(".css")) && manifest.assets.some(asset => asset.path.endsWith(".js")), "Missing embedded asset inventory");
const native = manifest.executables.find(item => item.arch === process.arch);
assert(native, "No executable for this runner");
// The source bank is an oracle only; the child runs solely from the extracted ZIP.
const questionBytes = await readFile(join(repo, "questions.json"));
assert(hash(questionBytes) === manifest.sources["questions.json"], "Smoke question oracle differs from the packaged build");
const questionBank = JSON.parse(questionBytes);
// No caller secrets, PORT, preload hooks, or Bun runtime settings reach the game.
const childEnv = { PORT: "0" };
for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "PATH", "Path"]) if (process.env[key]) childEnv[key] = process.env[key];
const child = Bun.spawn([join(bundle, native.path)], { cwd: work, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const sockets = [];
let stdout = "";
let stderr = "";
const stdoutTask = (async () => { for await (const chunk of child.stdout) stdout += Buffer.from(chunk).toString(); })();
const stderrTask = (async () => { for await (const chunk of child.stderr) stderr += Buffer.from(chunk).toString(); })();
const deadline = Date.now() + 25_000;
let port;
try {
  while (Date.now() < deadline) {
    port = Number(/Wonderland host: http:\/\/localhost:(\d+)\/host/.exec(stdout)?.[1]);
    if (port) break;
    assert(child.exitCode === null, `Packaged executable exited: ${stderr}`);
    await Bun.sleep(50);
  }
  assert(port > 0 && port !== 9276, `No isolated ephemeral startup port: ${stdout}\n${stderr}`);
  const origin = `http://127.0.0.1:${port}`;
  async function request(path) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5000) });
    assert(response.status === 200, `Packaged route ${path}: HTTP ${response.status}`);
    return response;
  }
  const health = await (await request("/health")).json();
  assert(health.ok && health.port === port && health.games === 0, "Unexpected packaged /health");
  await request("/host");
  for (const asset of manifest.assets) {
    assert(/^[A-Za-z0-9_./-]+$/.test(asset.path) && !asset.path.split("/").includes("..") && !/-v1\./i.test(asset.path), "Unsafe/retired manifest asset");
    if (!/\.(?:html|js|css|png)$/.test(asset.path)) continue;
    const response = await request(`/${asset.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length === asset.size && hash(bytes) === asset.sha256, `Embedded asset differs: ${asset.path}`);
    const type = response.headers.get("content-type") || "";
    assert(type.includes(asset.path.endsWith(".png") ? "image/png" : asset.path.endsWith(".css") ? "text/css" : asset.path.endsWith(".html") ? "text/html" : "javascript"), `Wrong asset content type: ${asset.path}`);
  }
  function connect(cookie, path = "/ws") {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    sockets.push(socket);
    const frames = [];
    const waiters = new Set();
    let failure;
    function fail(error) {
      failure = error;
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
      waiters.clear();
    }
    socket.addEventListener("error", () => fail(new Error("Packaged WebSocket failed")));
    socket.addEventListener("close", () => fail(new Error("Packaged WebSocket closed")));
    socket.addEventListener("message", event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { fail(new Error("Invalid WebSocket JSON")); return; }
      if (frame.type === "error") { fail(new Error(`Game protocol rejected smoke action: ${frame.message}`)); return; }
      for (const waiter of waiters) {
        if (!waiter.predicate(frame)) continue;
        clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(frame); return;
      }
      frames.push(frame);
    });
    return {
      send(message) { socket.send(JSON.stringify(message)); },
      next(predicate) {
        if (failure) return Promise.reject(failure);
        const index = frames.findIndex(predicate);
        if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, reject, timer: null };
          waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("Packaged WebSocket frame timed out")); }, 5000);
          waiters.add(waiter);
        });
      },
    };
  }
  async function student(teamId) {
    const response = await request("/");
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    assert(cookie, "Player page did not issue identity cookie");
    const connection = connect(cookie);
    await connection.next(frame => frame.type === "state");
    connection.send({ type: "join", teamId });
    const frame = await connection.next(frame => frame.type === "state" && frame.you !== null);
    return { connection, frame };
  }
  const first = await student("alice");
  const second = await student("rabbit");
  assert(first.frame.game.id === second.frame.game.id && second.frame.game.assignedHumans === 2, "Two packaged players were not assigned together");
  const hostCookie = (await request("/host")).headers.get("set-cookie")?.split(";", 1)[0];
  const host = connect(hostCookie, `/ws?host=1&game=${first.frame.game.id}`);
  let frame = await host.next(frame => frame.type === "state");
  host.send({ type: "start", version: frame.state.version });
  frame = await host.next(frame => frame.type === "state" && frame.state.phase === "playing");
  assert(frame.state.players.length === 4, "Packaged game did not fill four seats");
  const players = [first.connection, second.connection];
  let sawEntry = false;
  let sawQuestion = false;
  // Exercise real randomness without injecting test code into the compiled server.
  // A bounded walk fails closed if entry/question/movement cannot be reached.
  for (let step = 0; step < 180 && !sawQuestion; step++) {
    const state = frame.state;
    if (state.players[state.currentPlayer].isBot) {
      frame = await host.next(next => next.type === "state" && next.state.version > state.version);
      continue;
    }
    const player = players[state.currentPlayer];
    assert(player, "Unexpected human seat in smoke");
    let action;
    if (state.awaiting === "roll") action = { type: "roll" };
    else if (state.awaiting === "continue") action = { type: "continue" };
    else if (state.awaiting === "choice") { action = { type: "choose", action: "enter" }; sawEntry = true; }
    else if (state.awaiting === "piece") action = { type: "move", piece: state.legalPieces[0] };
    else if (state.awaiting === "answer") {
      const question = state.pendingQuestion;
      assert(question?.prompt && question.options.length === 4 && question.chapter >= 1 && question.chapter <= 12, "Real embedded question not delivered");
      assert(!Object.hasOwn(question, "answer"), "Question answer leaked before submission");
      const original = questionBank.find(item => item.prompt === question.prompt);
      assert(original?.prompt === question.prompt && original.chapter === question.chapter && original.options.every(option => question.options.includes(option)), "Packaged question differs from the real source bank");
      const index = question.options.indexOf(original.options[original.answer]);
      assert(index >= 0, "Correct source answer not present in packaged question");
      action = { type: "answer", index };
      sawQuestion = true;
    } else throw new Error(`Unexpected packaged decision: ${state.awaiting}`);
    player.send({ ...action, version: state.version });
    frame = await host.next(next => next.type === "state" && next.state.version > state.version);
    if (action.type === "answer") {
      assert(frame.state.lastFeedback?.correct === true, "Packaged correct answer was not accepted");
      assert(frame.state.players[state.currentPlayer].progress[state.selectedPiece] === state.players[state.currentPlayer].progress[state.selectedPiece] + state.roll, "Packaged correct answer did not move the selected piece");
    }
  }
  assert(sawEntry && sawQuestion, "Packaged gameplay did not exercise entry and a real question/answer");
  assert(child.exitCode === null, "Packaged executable stopped during smoke");
  console.log(`PASS ${manifest.platform}/${process.arch}: ZIP checksum, package inventory, binary architecture, native startup, all embedded HTML/JS/CSS/PNG assets, two-player WebSocket join, entry, real question and correct-answer movement.`);
} finally {
  for (const socket of sockets) socket.close();
  if (child.exitCode === null) child.kill();
  await child.exited;
  await Promise.all([stdoutTask, stderrTask]);
  if (stderr) console.error(stderr);
}

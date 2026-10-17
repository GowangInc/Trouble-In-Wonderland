import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run with the real Bun 1.4.3 CLI, not a Bun-compiled application hosting JS.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [platform, ...args] = process.argv.slice(2);
const targets = {
  linux: [["bun-linux-x64-baseline", "wonderland", "x64"]],
  windows: [["bun-windows-x64-baseline", "wonderland.exe", "x64"]],
  macos: [["bun-darwin-arm64", "wonderland-arm64", "arm64"], ["bun-darwin-x64-baseline", "wonderland-x64", "x64"]],
};
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function run(command, cwd = root, capture = false, env = process.env) {
  const result = Bun.spawnSync(command, { cwd, env, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  requireThat(result.exitCode === 0 && !result.error, `${command[0]} failed (${result.exitCode}): ${result.error?.message || "see output"}`);
  return capture ? result.stdout.toString().trim() : "";
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function regularFile(base, path) {
  requireThat(/^[A-Za-z0-9_./-]+$/.test(path) && !path.split("/").some(part => !part || part === "." || part === ".."), `Unsafe source path: ${path}`);
  const parts = path.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const info = await lstat(join(base, ...parts.slice(0, index)));
    requireThat(!info.isSymbolicLink() && (index === parts.length ? info.isFile() : info.isDirectory()), `Not a regular source path: ${path}`);
  }
  return readFile(join(base, path));
}
async function put(base, path, bytes, mode = 0o644) {
  await mkdir(dirname(join(base, path)), { recursive: true });
  await writeFile(join(base, path), bytes, { flag: "wx", mode });
  if (process.platform !== "win32") await chmod(join(base, path), mode);
}
async function fetchNotice(path) {
  // Pin notices to the exact compiler's source revision, not a moving branch.
  const url = `https://raw.githubusercontent.com/oven-sh/bun/c6da4a4d3010e5553438c60f6bd76d981976867c/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  requireThat(response.ok, `Cannot obtain required Bun notice: ${url} (${response.status})`);
  const text = await response.text();
  requireThat(text.includes("licensed") && text.length > 1000, "Bun license download is incomplete");
  return text;
}

requireThat(targets[platform], "Usage: bun scripts/build-release.js <linux|windows|macos> [--version 1.0.0] [--out NEW_DIRECTORY]");
requireThat(Bun.version === "1.4.3", `Bun 1.4.3 required; running ${Bun.version}`);
requireThat(process.platform !== "win32" || platform === "windows", "Build Unix ZIPs on Linux/macOS so executable permissions survive");
requireThat(run([process.execPath, "--version"], root, true) === "1.4.3", "process.execPath must be the standalone Bun 1.4.3 compiler");
let version = JSON.parse(await regularFile(root, "package.json")).version;
let output;
const seen = new Set();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index];
  requireThat(["--version", "--out"].includes(option) && args[index + 1] && !seen.has(option), `Invalid option: ${option}`);
  seen.add(option);
  if (option === "--version") version = args[index + 1];
  else output = resolve(args[index + 1]);
}
requireThat(typeof version === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version), "Use a safe semantic version, e.g. 1.0.0");
output ||= join(root, "dist", version, platform);
// Atomic directory creation reserves this output; a failed build remains for inspection.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const work = await mkdtemp(join(tmpdir(), "wonderland-build-"));
console.log(`Staging (retained, never deleted): ${work}`);
const stage = join(work, "source");
const name = `wonderland-${version}-${platform}-${platform === "macos" ? "universal" : "x64"}`;
const packageParent = join(work, "package");
const bundle = join(packageParent, name);
await mkdir(stage);
await mkdir(bundle, { recursive: true });
const tracked = run(["git", "ls-files", "--stage", "-z", "--", "public/"], root, true).split("\0").filter(Boolean);
requireThat(tracked.length > 0, "No tracked public assets; build from a Git clone with committed active assets");
const publicPaths = tracked.map(record => {
  const match = /^(100644|100755) [a-f0-9]+ 0\t(public\/.+)$/.exec(record);
  requireThat(match, `Unsupported Git asset entry: ${record}`);
  requireThat(!/(?:^|\/)\.|-v1\./i.test(match[2]), `Unexpected hidden/retired asset: ${match[2]}`);
  requireThat(/\.(?:html|js|css|png|LICENSE\.txt)$/.test(match[2]), `Unexpected public file type: ${match[2]}`);
  return match[2];
}).sort();
requireThat(new Set(publicPaths.map(path => path.toLowerCase())).size === publicPaths.length, "Case-colliding public paths");
requireThat(publicPaths.includes("public/vendor/qrcode-generator.LICENSE.txt"), "QR license must be tracked");
const sourceHashes = {};
const assets = [];
for (const path of ["server.js", "game.js", "questions.json", ...publicPaths]) {
  const bytes = await regularFile(root, path);
  await put(stage, path, bytes);
  sourceHashes[path] = hash(bytes);
  if (path.startsWith("public/")) assets.push({ path: path.slice(7), sha256: hash(bytes), size: bytes.length });
}
const questions = JSON.parse(await readFile(join(stage, "questions.json"), "utf8"));
requireThat(Array.isArray(questions) && questions.length === 500 && new Set(questions.map(question => question.chapter)).size === 12, "Release requires the complete 500-question, 12-chapter bank");
// Inherit only OS/toolchain settings: never compile secrets from a developer's environment.
const buildEnv = {};
for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
  if (process.env[key] !== undefined) buildEnv[key] = process.env[key];
}
const executables = [];
for (const [target, path, arch] of targets[platform]) {
  run([process.execPath, "build", "--compile", `--target=${target}`, "--asset", "./public", "--no-env-file", "--outfile", join(bundle, path), "./server.js"], stage, false, buildEnv);
  if (process.platform !== "win32") await chmod(join(bundle, path), 0o755);
  executables.push({ path, arch, sha256: hash(await readFile(join(bundle, path))) });
}
const shellHead = '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\ncd "$HERE"\n';
let launcher;
if (platform === "macos") {
  launcher = "Start Wonderland.command";
  await put(bundle, launcher, shellHead + 'case "$(uname -m)" in\n  arm64) exec "$HERE/wonderland-arm64" ;;\n  x86_64) exec "$HERE/wonderland-x64" ;;\n  *) printf "%s\\n" "Unsupported Mac architecture" >&2; exit 1 ;;\nesac\n', 0o755);
} else if (platform === "linux") {
  launcher = "start-wonderland.sh";
  await put(bundle, launcher, shellHead + 'exec "$HERE/wonderland"\n', 0o755);
} else {
  launcher = "Start Wonderland.cmd";
  await put(bundle, launcher, ['@echo off', 'setlocal DisableDelayedExpansion', 'pushd "%~dp0" || exit /b 1', '"%~dp0wonderland.exe"', 'set "result=%errorlevel%"', 'popd', 'exit /b %result%', ''].join("\r\n"));
}
await put(bundle, "README.md", await regularFile(root, "README.md"));
await put(bundle, "licenses/qrcode-generator.LICENSE.txt", await regularFile(root, "public/vendor/qrcode-generator.LICENSE.txt"));
await put(bundle, "licenses/Bun-LICENSE.md", await fetchNotice("LICENSE.md"));
await put(bundle, "START-HERE.txt", `Trouble in Wonderland ${version}\n\nExtract the entire ZIP first. No Bun or Node installation is needed.\nRun ${launcher}${platform === "linux" ? " (from a terminal: ./start-wonderland.sh)" : ""}.\nKeep that terminal open; Ctrl+C stops the server and clears all game progress.\nOpen http://localhost:9276/host on this computer; students use the LAN links printed there.\nDefault port: 9276. Override with the PORT environment variable before launching.\nNo browser is opened automatically. No administrator access is required.\nUse only a trusted classroom LAN; firewall permissions are your decision.\n\n${platform === "macos" ? "Includes separate Apple Silicon and Intel executables. The .command selects your architecture.\nUnsigned and not notarized: macOS may require a manual security approval. No launcher changes security settings.\n" : platform === "windows" ? "Windows x64 only. Windows may display an unsigned-application warning.\n" : "Linux x64 glibc build, not Alpine/musl or ARM. Requires Bun-supported host OS libraries.\n"}\nRuntime licensing and relinking guidance: licenses/Bun-LICENSE.md\nBun source at https://github.com/oven-sh/bun/tree/bun-v1.4.3\nApplication build inputs and SHA256 provenance: release-manifest.json\n`);
await put(bundle, "release-manifest.json", JSON.stringify({ schema: 1, version, platform, bun: "1.4.3", commit: run(["git", "rev-parse", "HEAD"], root, true), launcher, executables, questions: { count: questions.length, chapters: 12 }, sources: sourceHashes, assets }, null, 2) + "\n");
const archive = join(output, `${name}.zip`);
if (process.platform === "win32") {
  // Values travel through environment variables, not interpolated PowerShell code.
  run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; Compress-Archive -LiteralPath $env:WONDERLAND_PACKAGE -DestinationPath $env:WONDERLAND_ARCHIVE -CompressionLevel Optimal'], packageParent, false, { ...process.env, WONDERLAND_PACKAGE: bundle, WONDERLAND_ARCHIVE: archive });
} else {
  run(["zip", "-q", "-r", archive, name], packageParent);
}
const digest = hash(await readFile(archive));
await writeFile(`${archive}.sha256`, `${digest}  ${name}.zip\n`, { flag: "wx" });
requireThat(hash(await readFile(archive)) === digest, "Archive changed while checksumming");
console.log(`Archive: ${archive}\nSHA256: ${archive}.sha256\nNot smoke-tested. Run: bun scripts/smoke-release.js "${archive}"`);

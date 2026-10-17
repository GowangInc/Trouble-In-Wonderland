import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "./server.js";

let server;
let serverProcess;
let origin;
let connections;

beforeEach(async () => {
  let ready;
  let clockChanged;
  const started = new Promise(resolve => { ready = resolve; });
  // Bun 1.3 can retain closed WebSocket handles. Isolate server lifetime in a process.
  serverProcess = Bun.spawn([process.execPath, "-e", `
    const nativeNow = Date.now;
    let clock = null;
    Date.now = () => clock ?? nativeNow();
    Math.random = () => 0.999;
    process.on("message", message => {
      if (message.type !== "clock") return;
      clock = message.time;
      process.send({ type: "clock" });
    });
    const { startServer } = await import(${JSON.stringify(new URL("./server.js", import.meta.url).href)});
    const app = startServer({ port: 0, hostname: "127.0.0.1" });
    process.send({ type: "ready", port: app.port });
  `], {
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      if (message.type === "ready") ready(message.port);
      else if (message.type === "clock") clockChanged();
    },
  });
  server = {
    port: await started,
    setClock(time) {
      const changed = new Promise(resolve => { clockChanged = resolve; });
      serverProcess.send({ type: "clock", time });
      return changed;
    },
  };
  origin = `http://127.0.0.1:${server.port}`;
  connections = [];
});
afterEach(async () => {
  for (const connection of connections || []) connection.socket.close();
  serverProcess.kill();
  await serverProcess.exited;
});

async function documentCookie(existing, path = "/") {
  const response = await fetch(`${origin}${path}`, { headers: existing ? { Cookie: existing } : {} });
  expect(response.status).toBe(200);
  const header = response.headers.get("set-cookie");
  if (existing && !header) return existing;
  expect(Boolean(header?.includes("HttpOnly") && header.includes("SameSite=Lax") && header.includes("Path=/") && header.includes(`wonderland_identity_${server.port}=`))).toBe(true);
  return header.split(";", 1)[0];
}

function connect(cookie, path = "/ws") {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const frames = [];
  const waiters = new Set();
  let closed = false;
  const connection = {
    socket,
    latest: null,
    send(message) { socket.send(JSON.stringify(message)); },
    next(predicate = () => true) {
      const found = frames.findIndex(predicate);
      if (found !== -1) return Promise.resolve(frames.splice(0, found + 1).at(-1));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("Expected classroom protocol frame was not received.")); }, 3000);
        waiters.add(waiter);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      return new Promise(resolve => { socket.addEventListener("close", resolve, { once: true }); socket.close(); });
    },
  };
  socket.addEventListener("message", event => {
    const frame = JSON.parse(event.data);
    if (frame.type === "state") connection.latest = frame;
    for (const waiter of waiters) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      frames.length = 0;
      waiter.resolve(frame);
      return;
    }
    frames.push(frame);
  });
  socket.addEventListener("close", () => { closed = true; });
  connections.push(connection);
  return connection;
}
async function player(cookie, path = "/ws") {
  const connection = connect(cookie, path);
  await connection.next(frame => frame.type === "state");
  return connection;
}
async function command(connection, type, fields = {}) {
  const version = connection.latest.state.version;
  connection.send({ type, version, ...fields });
  return connection.next(frame => frame.type === "state" && frame.state.version > version);
}
async function choose(connection, teamId) {
  connection.send({ type: "join", teamId });
  return connection.next(frame => frame.type === "state" && frame.you !== null);
}

describe("automatic classroom tables", () => {
  test("places are FCFS before character choice; a fifth picker cannot overfill a table", async () => {
    const students = [];
    const cookies = [];
    for (let index = 0; index < 5; index++) {
      const cookie = await documentCookie();
      cookies.push(cookie);
      students.push(await player(cookie));
    }
    const first = students[0].latest.game.id;
    expect(students.slice(0, 4).every(student => student.latest.game.id === first)).toBe(true);
    expect(students[4].latest.game.id !== first).toBe(true);
    expect(students.every(student => student.latest.you === null)).toBe(true);
    expect(students[3].latest.game.assignedHumans).toBe(4);
    expect(students[3].latest.game.connectedHumans).toBe(4);
    expect(students[3].latest.state.players.every(team => !team.occupied)).toBe(true);
    expect(students[3].latest.game.fillDeadline > students[3].latest.serverTime).toBe(true);
    const health = await (await fetch(`${origin}/health`)).json();
    expect(health).toEqual({ ok: true, port: server.port, games: 2, waitingGames: 2 });
    const monitor = connect(null, "/monitor");
    const frame = await monitor.next(frame => frame.type === "games");
    expect(frame.games.map(game => game.assignedHumans)).toEqual([4, 1]);
    const serialized = JSON.stringify(frame);
    expect(cookies.every(cookie => !serialized.includes(cookie.slice(cookie.indexOf("=") + 1)))).toBe(true);
  });

  test("chapter defaults govern the first automatic group and its actual questions", async () => {
    const monitor = connect(null, "/monitor");
    await monitor.next(frame => frame.type === "games");
    monitor.send({ type: "defaults", chapters: [2] });
    await monitor.next(frame => frame.type === "ack");
    const student = await player(await documentCookie());
    await choose(student, "alice");
    const host = await player(await documentCookie(), `/ws?host=1&game=${student.latest.game.id}`);
    await command(host, "start");
    await student.next(frame => frame.type === "state" && frame.state.phase === "playing");
    await command(student, "roll");
    await command(student, "choose", { action: "enter" });
    await command(student, "continue");
    await command(student, "roll");
    const frame = await command(student, "move", { piece: 0 });
    expect(frame.state.pendingQuestion.chapter).toBe(2);
    expect(Object.hasOwn(frame.state.pendingQuestion, "answer")).toBe(false);
    expect(Object.hasOwn(frame.state.pendingQuestion, "sourceQuote")).toBe(false);
  });

  test("expired disconnected groups keep their places without taking a new student's character choice", async () => {
    const cookie = await documentCookie();
    const first = await player(cookie);
    const original = first.latest.game;
    await first.close();
    await server.setClock(original.fillDeadline + 1);
    const newcomer = await player(await documentCookie());
    expect(newcomer.latest.game.id !== original.id).toBe(true);
    expect(newcomer.latest.state.phase).toBe("lobby");
    expect(newcomer.latest.you).toBeNull();
    expect(newcomer.latest.game.assignedHumans).toBe(1);
    const returning = await player(cookie);
    expect(returning.latest.game.id === original.id).toBe(true);
    expect(returning.latest.state.phase).toBe("playing");
    expect(returning.latest.you).toBe(0);
    expect(returning.latest.state.players.filter(team => team.isBot).length).toBe(3);
  });

  test("same-cookie tabs restore character and turn state without consuming another place", async () => {
    const cookie = await documentCookie();
    const first = await player(cookie);
    await choose(first, "alice");
    const gameId = first.latest.game.id;
    const host = await player(await documentCookie(undefined, `/host?game=${gameId}`), `/ws?host=1&game=${gameId}`);
    await command(host, "start");
    await first.next(frame => frame.type === "state" && frame.state.phase === "playing");
    await command(first, "roll");
    if (first.latest.state.canEnter) await command(first, "choose", { action: "enter" });
    await host.next(frame => frame.type === "state" && frame.state.version === first.latest.state.version);
    await command(host, "pause");
    await first.next(frame => frame.type === "state" && frame.state.paused);
    const before = first.latest.state;
    const second = await player(cookie, "/ws?game=forged&teamId=hatter&playerIndex=3&token=forged");
    expect(second.latest.you).toBe(0);
    expect(second.latest.game.id === gameId).toBe(true);
    expect(second.latest.game.assignedHumans).toBe(1);
    expect(second.latest.game.connectedHumans).toBe(1);
    expect(second.latest.state.players[0].progress).toEqual(before.players[0].progress);
    expect(second.latest.state.roll).toBe(before.roll);
    await first.close();
    const surviving = await second.next(frame => frame.type === "state" && frame.state.players[0].connected);
    expect(surviving.game.connectedHumans).toBe(1);
    await second.close();
    await host.next(frame => frame.type === "state" && !frame.state.players[0].connected);
    const restored = await player(cookie);
    expect(restored.latest.you).toBe(0);
    expect(restored.latest.game.id === gameId).toBe(true);
    expect(restored.latest.state.roll).toBe(before.roll);
    expect(restored.latest.state.players[0].progress).toEqual(before.players[0].progress);
    expect(await documentCookie(cookie) === cookie).toBe(true);
  });

  test("four chosen identities start immediately and forged identity fields cannot redirect a command", async () => {
    const students = [];
    for (let index = 0; index < 5; index++) students.push(await player(await documentCookie()));
    const tableA = students[0].latest.game.id;
    const tableB = students[4].latest.game.id;
    for (const [index, team] of ["alice", "rabbit", "cat", "hatter"].entries()) await choose(students[index], team);
    await students[0].next(frame => frame.type === "state" && frame.state.phase === "playing");
    expect(students[3].latest.state.phase).toBe("playing");
    expect(students[3].latest.game.fillDeadline).toBeNull();
    expect(students[3].latest.state.players.every(team => !team.isBot)).toBe(true);
    const hostB = await player(await documentCookie(), `/ws?host=1&game=${tableB}`);
    const versionB = hostB.latest.state.version;
    const versionA = students[0].latest.state.version;
    students[1].send({ type: "roll", version: versionA, gameId: tableB, playerIndex: 0, teamId: "alice", host: true, bot: true });
    await students[1].next(frame => frame.type === "error");
    expect(students[0].latest.state.version).toBe(versionA);
    await command(students[0], "roll", { gameId: tableB, teamId: "hatter", playerIndex: 3 });
    expect(students[0].latest.game.id === tableA).toBe(true);
    expect(hostB.latest.state.version).toBe(versionB);
    await command(hostB, "configure", { chapters: [2], gameId: tableA });
    expect(hostB.latest.state.chapters).toEqual([2]);
    expect(students[0].latest.state.chapters).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  test("dashboard defaults, explicit host routes and finished-only close keep stale identities queueable", async () => {
    const cookie = await documentCookie();
    const student = await player(cookie);
    await choose(student, "alice");
    const gameId = student.latest.game.id;
    const monitor = connect(null, "/monitor");
    await monitor.next(frame => frame.type === "games");
    monitor.send({ type: "close-game", gameId });
    await monitor.next(frame => frame.type === "error");
    monitor.send({ type: "defaults", chapters: [3] });
    await monitor.next(frame => frame.type === "games" && frame.defaults.chapters.length === 1 && frame.defaults.chapters[0] === 3);
    monitor.send({ type: "create-game", name: "Next class" });
    const created = await monitor.next(frame => frame.type === "games" && frame.games.length === 2);
    const next = created.games.find(game => game.id !== gameId);
    expect(next.state.chapters).toEqual([3]);
    expect(next.assignedHumans).toBe(0);
    const host = await player(await documentCookie(), `/ws?host=1&game=${gameId}`);
    expect(host.latest.game.assignedHumans).toBe(1);
    await command(host, "start");
    await command(host, "end");
    monitor.send({ type: "close-game", gameId });
    await monitor.next(frame => frame.type === "games" && frame.games.length === 1);
    await student.close();
    const returned = await player(cookie, `/ws?game=${gameId}`);
    expect(returned.latest.game.id === next.id).toBe(true);
    expect(returned.latest.you).toBeNull();
    expect(returned.latest.game.assignedHumans).toBe(1);
    const missing = await fetch(`${origin}/host?game=${gameId}`);
    expect(missing.status).toBe(404);
    expect((await missing.text()).includes('href="/host"')).toBe(true);
    const missingSocket = await fetch(`${origin}/ws?host=1&game=${gameId}`, { headers: { Origin: origin, Cookie: cookie } });
    expect(missingSocket.status).toBe(404);
    const dashboard = await fetch(`${origin}/host`);
    expect(dashboard.status).toBe(200);
    const detail = await fetch(`${origin}/host?game=${next.id}`);
    expect(detail.status).toBe(200);
    for (const path of ["/server.js", "/questions.json"]) expect((await fetch(`${origin}${path}`)).status).toBe(404);
    expect((await fetch(`${origin}/monitor`, { headers: { Origin: "http://example.invalid" } })).status).toBe(403);
    expect((await fetch(`${origin}/ws`, { headers: { Origin: origin } })).status).toBe(401);
  });
  test("unknown cookies are replaced only by server-issued port-scoped document cookies", async () => {
    const cookie = await documentCookie();
    const edited = await documentCookie(`wonderland_identity_${server.port}=edited`);
    expect(edited !== cookie).toBe(true);
    const first = await player(cookie);
    const other = await player(edited);
    expect(other.latest.game.assignedHumans).toBe(2);
    expect(first.latest.you).toBeNull();
    const preview = startServer({ port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(`http://127.0.0.1:${preview.port}/`, { headers: { Cookie: cookie } });
      const replacement = response.headers.get("set-cookie");
      expect(Boolean(replacement?.startsWith(`wonderland_identity_${preview.port}=`))).toBe(true);
      expect(await documentCookie(cookie) === cookie).toBe(true);
    } finally {
      await preview.stop(true);
    }
  });
});

import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import questions from "./questions.json" with { type: "json" };
import { createGame, TEAMS } from "./game.js";

const WAIT_MS = 60_000;
const publicFiles = new Map([
  ["/", "./public/index.html"], ["/index.html", "./public/index.html"],
  ["/host", "./public/host.html"], ["/host.html", "./public/host.html"],
  ["/host.js", "./public/host.js"], ["/host.css", "./public/host.css"],
  ["/page-tools.js", "./public/page-tools.js"], ["/app.js", "./public/app.js"],
  ["/style.css", "./public/style.css"], ["/board.js", "./public/board.js"],
  ["/dice-audio.js", "./public/dice-audio.js"],
  ["/vendor/qrcode-generator.js", "./public/vendor/qrcode-generator.js"],
  ["/assets/wonderland-garden-v2.png", "./public/assets/wonderland-garden-v2.png"],
  ["/assets/alice-nightmare-v2.png", "./public/assets/alice-nightmare-v2.png"],
  ["/assets/rabbit-nightmare-v2.png", "./public/assets/rabbit-nightmare-v2.png"],
  ["/assets/cat-nightmare-v2.png", "./public/assets/cat-nightmare-v2.png"],
  ["/assets/hatter-nightmare-v2.png", "./public/assets/hatter-nightmare-v2.png"],
  ["/assets/wonderland-region-stones-v2.png", "./public/assets/wonderland-region-stones-v2.png"],
  ["/assets/wonderland-table-foreground-v2.png", "./public/assets/wonderland-table-foreground-v2.png"],
]);
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function loopback(address) {
  return address === "::1" || /^127\./.test(address || "") || /^::ffff:127\./i.test(address || "");
}
function joinUrls(port) {
  const urls = new Set();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(?:utun|tun|tap|wg\d|wintun|docker|veth|br-|virbr|awdl|llw|ap\d|vEthernet)/i.test(name) || /vpn|wireguard|tailscale/i.test(name)) continue;
    for (const address of addresses || []) {
      if (!address || address.internal || (address.family !== "IPv4" && address.family !== 4)) continue;
      if (!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address.address)) continue;
      urls.add(`http://${address.address}:${port}/`);
    }
  }
  return [...urls];
}
function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}
function fail(ws, message) { send(ws, { type: "error", message }); }
function chapters(value) {
  if (!Array.isArray(value) || !value.length || value.some(chapter => !Number.isInteger(chapter) || chapter < 1 || chapter > 12)) throw new Error("Select at least one chapter from 1 to 12.");
  const result = [...new Set(value)].sort((a, b) => a - b);
  if (!questions.some(question => result.includes(question.chapter))) throw new Error("There are no questions in the selected chapters.");
  return result;
}

// Each server owns its registry; importing this module never opens a listener.
export function startServer({ port = Number(Bun.env.PORT || 9276), hostname = "0.0.0.0" } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.");
  const games = new Map();
  const identities = new Map();
  const monitors = new Set();
  let defaults = Array.from({ length: 12 }, (_, index) => index + 1);
  let sequence = 0;
  let stopped = false;

  function createRoom(name, selected = defaults) {
    const chosen = chapters(selected);
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 80)) throw new Error("Use a game name between 1 and 80 characters.");
    const engine = createGame({ questions });
    engine.dispatch({ host: true }, { type: "configure", version: engine.snapshot().version, chapters: chosen });
    const room = { id: randomBytes(12).toString("base64url"), name: name?.trim() || `Table ${++sequence}`,
      engine, claims: new Set(), sockets: new Set(), fillDeadline: null, fillTimer: null, botTimer: null, graceTimers: new Map() };
    games.set(room.id, room);
    return room;
  }
  function metadata(room) {
    return { id: room.id, name: room.name, fillDeadline: room.fillDeadline,
      assignedHumans: room.claims.size, connectedHumans: [...room.claims].filter(identity => identity.sockets.size > 0).length };
  }
  function monitorFrame() {
    return { type: "games", games: [...games.values()].map(room => ({ ...metadata(room), state: room.engine.snapshot() })),
      defaults: { chapters: [...defaults] }, serverTime: Date.now() };
  }
  function broadcastMonitor() {
    if (!monitors.size) return;
    const frame = monitorFrame();
    for (const ws of monitors) send(ws, frame);
  }
  function sendState(ws, state = ws.data.room.engine.snapshot()) {
    const { room, identity, member, host } = ws.data;
    send(ws, { type: "state", game: metadata(room), state, you: member ? identity.playerIndex : null, host, serverTime: Date.now() });
  }
  function scheduleBot(room, state) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
    if (stopped || state.phase !== "playing" || state.paused || !state.players[state.currentPlayer].isBot) return;
    const delay = state.awaiting === "continue" ? 2600 : state.awaiting === "answer" ? 1900 : 1000;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!games.has(room.id)) return;
      const action = room.engine.nextBotAction();
      if (!action) return;
      room.engine.dispatch({ playerIndex: room.engine.snapshot().currentPlayer, bot: true }, action);
      broadcast(room);
    }, delay);
  }
  function broadcast(room) {
    const state = room.engine.snapshot();
    for (const ws of room.sockets) sendState(ws, state);
    scheduleBot(room, state);
    broadcastMonitor();
  }
  function clearGrace(room, identity) {
    clearTimeout(room.graceTimers.get(identity));
    room.graceTimers.delete(identity);
  }
  function armGrace(room, identity) {
    clearGrace(room, identity);
    if (identity.playerIndex === null || identity.sockets.size || identity.disconnectedAt === null) return;
    const cover = () => {
      room.graceTimers.delete(identity);
      if (stopped || !games.has(room.id) || identity.sockets.size || !room.claims.has(identity)) return;
      room.engine.setController(identity.playerIndex, { bot: true, connected: false });
      broadcast(room);
    };
    const remaining = identity.disconnectedAt + WAIT_MS - Date.now();
    if (remaining <= 0) cover();
    else room.graceTimers.set(identity, setTimeout(cover, remaining));
  }
  function choose(room, identity, teamId) {
    if (identity.playerIndex !== null) {
      if (TEAMS[identity.playerIndex].id !== teamId) throw new Error("Your reserved character cannot be changed.");
      return;
    }
    identity.playerIndex = room.engine.join(teamId);
    if (!identity.sockets.size) {
      room.engine.disconnect(identity.playerIndex);
      armGrace(room, identity);
    }
  }
  function assignUnchosen(room) {
    for (const identity of room.claims) {
      if (identity.playerIndex !== null) continue;
      const team = room.engine.snapshot().players.find(player => !player.occupied);
      choose(room, identity, team.teamId);
    }
  }
  function clearFill(room) {
    clearTimeout(room.fillTimer);
    room.fillTimer = null;
    room.fillDeadline = null;
  }
  function startRoom(room, selected) {
    if (![...room.claims].some(identity => identity.sockets.size)) throw new Error("At least one student must be connected before Go.");
    assignUnchosen(room);
    room.engine.dispatch({ host: true }, { type: "start", version: room.engine.snapshot().version, ...(selected ? { chapters: selected } : {}) });
    clearFill(room);
  }
  function maybeStart(room) {
    const state = room.engine.snapshot();
    if (state.phase !== "lobby" || ![...room.claims].some(identity => identity.sockets.size)) return;
    const ready = room.claims.size === TEAMS.length && [...room.claims].every(identity => identity.playerIndex !== null);
    if (ready || (room.fillDeadline !== null && (room.fillTimer === null || Date.now() >= room.fillDeadline))) startRoom(room);
  }
  function beginFill(room) {
    clearFill(room);
    if (!room.claims.size) return;
    room.fillDeadline = Date.now() + WAIT_MS;
    room.fillTimer = setTimeout(() => {
      room.fillTimer = null;
      if (stopped || !games.has(room.id)) return;
      maybeStart(room);
      broadcast(room);
    }, WAIT_MS);
  }
  function reserve(identity, selectedRoom = null) {
    let room = games.get(identity.gameId);
    if (room) {
      if (selectedRoom && room !== selectedRoom) throw new Error("This browser already has a place at another table. Open its player page to return.");
      return room;
    }
    identity.gameId = null;
    identity.playerIndex = null;
    room = selectedRoom || [...games.values()].find(candidate =>
      candidate.engine.snapshot().phase === "lobby" && candidate.claims.size < TEAMS.length &&
      (candidate.fillDeadline === null || (candidate.fillTimer !== null && Date.now() < candidate.fillDeadline)));
    if (!room) room = createRoom();
    if (room.engine.snapshot().phase !== "lobby" || room.claims.size >= TEAMS.length) throw new Error("This table is not accepting new students.");
    room.claims.add(identity);
    identity.gameId = room.id;
    if (room.claims.size === 1) beginFill(room);
    return room;
  }
  function attachMember(ws, room) {
    const identity = ws.data.identity;
    ws.data.member = true;
    ws.data.room = room;
    identity.sockets.add(ws);
    identity.disconnectedAt = null;
    clearGrace(room, identity);
    if (identity.playerIndex !== null) room.engine.setController(identity.playerIndex, { bot: false, connected: true });
  }
  function join(ws, message) {
    const { identity, room } = ws.data;
    if (!ws.data.member) {
      reserve(identity, room);
      attachMember(ws, room);
    }
    choose(room, identity, message.teamId);
    send(ws, { type: "joined", teamId: TEAMS[identity.playerIndex].id, you: identity.playerIndex });
    maybeStart(room);
    broadcast(room);
  }
  function disposeRoom(room) {
    clearFill(room);
    clearTimeout(room.botTimer);
    for (const timer of room.graceTimers.values()) clearTimeout(timer);
    room.graceTimers.clear();
  }
  function monitorAction(ws, message) {
    if (message.type === "create-game") createRoom(message.name, message.chapters === undefined ? defaults : message.chapters);
    else if (message.type === "defaults") defaults = chapters(message.chapters);
    else if (message.type === "close-game") {
      const room = games.get(message.gameId);
      if (!room) throw new Error("That game no longer exists.");
      if (room.engine.snapshot().phase !== "finished") throw new Error("Only finished games can be closed.");
      disposeRoom(room);
      games.delete(room.id);
      for (const identity of room.claims) {
        identity.gameId = null;
        identity.playerIndex = null;
        identity.sockets.clear();
      }
      for (const socket of room.sockets) socket.close(1012, "Game closed. Reconnect to join the queue.");
    } else throw new Error("Unknown dashboard action.");
    broadcastMonitor();
  }
  function handle(ws, data) {
    if (!ws.data.monitor && !ws.data.room) return;
    if (typeof data !== "string") return fail(ws, "Use a JSON text message.");
    let message;
    try { message = JSON.parse(data); } catch { return fail(ws, "Invalid JSON message."); }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") return fail(ws, "Invalid action.");
    try {
      if (ws.data.monitor) {
        monitorAction(ws, message);
        send(ws, { type: "ack" });
        return;
      }
      const { room, identity } = ws.data;
      if (!games.has(room.id)) throw new Error("This game has closed. Reconnect to join another table.");
      if (message.type === "join") return join(ws, message);
      if (message.type === "start" && ws.data.host) {
        if (message.version !== room.engine.snapshot().version) throw new Error("The game changed. Use the latest board and try again.");
        if (room.engine.snapshot().phase !== "lobby") throw new Error("The adventure has already started.");
        const selected = message.chapters === undefined ? undefined : chapters(message.chapters);
        startRoom(room, selected);
      } else {
        room.engine.dispatch({ host: ws.data.host, playerIndex: ws.data.member ? identity.playerIndex : null, bot: false }, message);
        if (message.type === "reset") {
          beginFill(room);
          for (const claim of room.claims) armGrace(room, claim);
        }
      }
      broadcast(room);
    } catch (error) {
      fail(ws, error.message);
      if (ws.data.monitor) send(ws, monitorFrame());
      else if (games.has(ws.data.room.id)) sendState(ws);
    }
  }
  function detach(ws) {
    if (ws.data.monitor) { monitors.delete(ws); return; }
    const { room, identity, member } = ws.data;
    if (!room) return;
    room.sockets.delete(ws);
    if (member) {
      identity.sockets.delete(ws);
      if (!identity.sockets.size) {
        identity.disconnectedAt = Date.now();
        if (games.has(room.id) && identity.gameId === room.id && identity.playerIndex !== null) {
          room.engine.disconnect(identity.playerIndex);
          if (!stopped) armGrace(room, identity);
        }
      }
    }
    if (!stopped && games.has(room.id)) broadcast(room);
  }
  function cookieName(boundPort) { return `wonderland_identity_${boundPort}`; }
  function identify(request, boundPort) {
    const name = `${cookieName(boundPort)}=`;
    const value = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(name))?.slice(name.length);
    return identities.get(value);
  }
  function issueIdentity(boundPort) {
    const value = randomBytes(32).toString("base64url");
    const identity = { gameId: null, playerIndex: null, sockets: new Set(), disconnectedAt: null };
    identities.set(value, identity);
    return `${cookieName(boundPort)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
  }
  const server = Bun.serve({
    port, hostname,
    async fetch(request, server) {
      const url = new URL(request.url);
      const local = loopback(server.requestIP(request)?.address);
      if (url.pathname === "/ws" || url.pathname === "/monitor") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
        if (request.headers.get("origin") !== url.origin) return new Response("Same-origin WebSocket required", { status: 403, headers });
        const monitor = url.pathname === "/monitor";
        const host = monitor || url.searchParams.get("host") === "1";
        if (host && !local) return new Response("Host controls are available on this computer only", { status: 403, headers });
        const identity = identify(request, server.port);
        if (!monitor && !identity) return new Response("Open the player page first to receive a classroom identity.", { status: 401, headers });
        const room = host && !monitor ? games.get(url.searchParams.get("game")) : null;
        if (host && !monitor && !room) return new Response("Game not found. Return to /host.", { status: 404, headers });
        if (server.upgrade(request, { data: { identity, host, monitor, room, member: false } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400, headers });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers });
      if (url.pathname === "/health") return Response.json({ ok: true, port: server.port, games: games.size,
        waitingGames: [...games.values()].filter(room => room.engine.snapshot().phase === "lobby").length }, { headers });
      if (url.pathname === "/join-info") return Response.json({ urls: joinUrls(server.port) }, { headers });
      if ((url.pathname === "/host" || url.pathname === "/host.html") && !local) return new Response("Open the host page on the server computer using localhost.", { status: 403, headers });
      let path = publicFiles.get(url.pathname);
      if (url.pathname === "/host" && url.searchParams.has("game")) {
        if (!games.has(url.searchParams.get("game"))) return new Response('<!doctype html><title>Game not found</title><h1>This game is no longer available</h1><p><a href="/host">Back to all games</a></p>', { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
        path = "./public/index.html";
      }
      if (!path) return new Response("Not found", { status: 404, headers });
      const file = Bun.file(new URL(path, import.meta.url));
      if (!(await file.exists())) return new Response("Not found", { status: 404, headers });
      const responseHeaders = { ...headers, "Content-Type": file.type };
      const document = ["/", "/index.html", "/host", "/host.html"].includes(url.pathname);
      if (document && !identify(request, server.port)) responseHeaders["Set-Cookie"] = issueIdentity(server.port);
      return new Response(request.method === "HEAD" ? null : file, { headers: responseHeaders });
    },
    websocket: {
      maxPayloadLength: 4096,
      open(ws) {
        if (ws.data.monitor) { monitors.add(ws); send(ws, monitorFrame()); return; }
        let room = ws.data.room;
        if (ws.data.host && (!room || !games.has(room.id))) {
          fail(ws, "Game not found. Return to /host to open an existing game.");
          return;
        }
        if (!ws.data.host) {
          room = reserve(ws.data.identity);
          attachMember(ws, room);
        }
        room.sockets.add(ws);
        maybeStart(room);
        broadcast(room);
      },
      message: handle,
      close: detach,
    },
  });
  return {
    port: server.port,
    stop(closeActiveConnections = true) {
      stopped = true;
      for (const room of games.values()) disposeRoom(room);
      return server.stop(closeActiveConnections);
    },
  };
}

if (import.meta.main) {
  const server = startServer();
  console.log(`Wonderland host: http://localhost:${server.port}/host`);
  const urls = joinUrls(server.port);
  for (const url of urls) console.log(`Student join (same LAN): ${url}`);
  if (!urls.length) console.log("No classroom LAN IPv4 address found. Connect this computer to the classroom network.");
  console.log("Independent in-memory classroom tables; restarting clears all reservations and progress.");
}

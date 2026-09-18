import http from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { createLexicon } from "./src/lexicon.js";
import { DIFFICULTIES, GameEngine } from "./src/game-engine.js";

const require = createRequire(import.meta.url);
const frenchWords = require("an-array-of-french-words");
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const lexicon = createLexicon(frenchWords);
const rooms = new Map();
const sessions = new Map();
const MAX_PLAYERS = 8;
const SESSION_GRACE_MS = 90_000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function cleanName(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 18);
}

function cleanCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function createCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(0, 30)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code) {
  const game = new GameEngine({ lexicon, code });
  return {
    code,
    game,
    sockets: new Map(),
    liveInput: null,
    timer: null,
    eventId: 0,
    lastEvent: null,
    rate: new Map(),
    actions: new Map()
  };
}

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, makeRoom(code));
  return rooms.get(code);
}

function playerFor(room, id) {
  return room.game.players.get(id);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function stateFor(room) {
  return {
    type: "state",
    state: {
      ...room.game.snapshot(),
      liveInput: room.liveInput,
      lastEvent: room.lastEvent
    }
  };
}

function broadcast(room) {
  const message = stateFor(room);
  for (const socket of room.sockets.values()) send(socket, message);
}

function setEvent(room, event) {
  room.eventId += 1;
  room.lastEvent = { ...event, id: room.eventId };
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function scheduleTurn(room) {
  clearTimer(room);
  if (room.game.phase !== "playing") return;
  const turnId = room.game.turnId;
  const delay = Math.max(0, room.game.expiresAt - Date.now());
  room.timer = setTimeout(() => {
    if (room.game.phase !== "playing" || room.game.turnId !== turnId) return;
    const result = room.game.expire();
    if (result.type === "timeout") {
      room.liveInput = null;
      setEvent(room, result);
      broadcast(room);
      scheduleTurn(room);
    }
  }, delay + 5);
}

function removeRoomIfEmpty(room) {
  if (room.game.players.size === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return true;
  }
  return false;
}

function disconnected(room, playerId) {
  const player = playerFor(room, playerId);
  if (!player) return;
  player.connected = false;
  if (room.game.hostId === playerId) room.game.transferHost();
  broadcast(room);

  setTimeout(() => {
    const current = playerFor(room, playerId);
    if (!current || current.connected) return;
    const session = sessions.get(current.sessionToken);
    if (session) sessions.delete(current.sessionToken);
    const wasActive = room.game.activePlayerId === playerId;
    room.game.removePlayer(playerId);
    if (wasActive && room.game.phase === "playing") scheduleTurn(room);
    broadcast(room);
    removeRoomIfEmpty(room);
  }, SESSION_GRACE_MS);
}

function markConnected(room, playerId, socket) {
  const player = playerFor(room, playerId);
  if (!player) return false;
  const oldSocket = room.sockets.get(playerId);
  if (oldSocket && oldSocket !== socket) oldSocket.close(4001, "Reconnexion");
  player.connected = true;
  room.sockets.set(playerId, socket);
  socket.playerId = playerId;
  socket.roomCode = room.code;
  return true;
}

function makeSession(room, playerId) {
  const token = randomUUID();
  const player = playerFor(room, playerId);
  player.sessionToken = token;
  sessions.set(token, { roomCode: room.code, playerId, lastSeen: Date.now() });
  return token;
}

function allow(room, playerId, bucket, max, windowMs = 1000) {
  const key = `${playerId}:${bucket}`;
  const now = Date.now();
  const recent = (room.rate.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  room.rate.set(key, recent);
  return true;
}

function validationMessage(reason) {
  return {
    unknown: "Mot inconnu",
    fragment: "La séquence n’est pas dans ce mot",
    duplicate: "Mot déjà utilisé"
  }[reason] ?? "Proposition invalide";
}

function joinExisting(socket, room, name, token) {
  const session = token && sessions.get(token);
  if (session?.roomCode === room.code && playerFor(room, session.playerId)) {
    const player = playerFor(room, session.playerId);
    if (name) player.name = name;
    markConnected(room, player.id, socket);
    session.lastSeen = Date.now();
    send(socket, { type: "welcome", sessionToken: token, playerId: player.id, roomCode: room.code });
    broadcast(room);
    return true;
  }

  if (room.game.players.size >= MAX_PLAYERS) {
    send(socket, { type: "error", code: "ROOM_FULL", message: "Ce salon est complet." });
    return false;
  }
  const player = room.game.addPlayer({ id: randomUUID(), name, connected: true });
  room.sockets.set(player.id, socket);
  socket.playerId = player.id;
  socket.roomCode = room.code;
  const sessionToken = makeSession(room, player.id);
  send(socket, { type: "welcome", sessionToken, playerId: player.id, roomCode: room.code });
  broadcast(room);
  return true;
}

function handleMessage(socket, message) {
  if (!message || typeof message !== "object") return;
  const room = socket.roomCode ? rooms.get(socket.roomCode) : null;

  if (message.type === "create") {
    if (socket.roomCode) return;
    const name = cleanName(message.name);
    if (!name) return send(socket, { type: "error", code: "NAME_REQUIRED", message: "Choisis un pseudo." });
    const newRoom = roomFor(createCode());
    joinExisting(socket, newRoom, name, null);
    return;
  }

  if (message.type === "join") {
    if (socket.roomCode) return;
    const code = cleanCode(message.code);
    const name = cleanName(message.name);
    if (!code || !name) return send(socket, { type: "error", code: "JOIN_REQUIRED", message: "Indique un pseudo et un code." });
    const target = rooms.get(code);
    if (!target) return send(socket, { type: "error", code: "ROOM_NOT_FOUND", message: "Salon introuvable." });
    joinExisting(socket, target, name, null);
    return;
  }

  if (message.type === "resume") {
    if (socket.roomCode) return;
    const token = String(message.sessionToken ?? "");
    const session = sessions.get(token);
    const target = session && rooms.get(session.roomCode);
    if (!target || !playerFor(target, session.playerId)) {
      return send(socket, { type: "error", code: "SESSION_EXPIRED", message: "Ta session a expiré, rejoins le salon." });
    }
    joinExisting(socket, target, "", token);
    return;
  }

  if (!room || !socket.playerId) return;
  const player = playerFor(room, socket.playerId);
  if (!player) return;
  const session = sessions.get(player.sessionToken);
  if (session) session.lastSeen = Date.now();

  if (message.type === "typing") {
    if (!allow(room, player.id, "typing", 35) || room.game.phase !== "playing" || room.game.activePlayerId !== player.id) return;
    room.liveInput = { playerId: player.id, text: String(message.text ?? "").slice(0, 48) };
    broadcast(room);
    return;
  }

  if (message.type === "submit") {
    if (!allow(room, player.id, "submit", 12) || room.game.phase !== "playing" || room.game.activePlayerId !== player.id) return;
    const actionId = String(message.actionId ?? "").slice(0, 80);
    if (actionId && room.actions.has(actionId)) return;
    if (actionId) room.actions.set(actionId, Date.now());
    const result = room.game.submit(player.id, String(message.word ?? "").slice(0, 48));
    if (result.type === "invalid") return send(socket, { type: "feedback", level: "error", message: validationMessage(result.reason) });
    if (result.type === "ignored") return;
    room.liveInput = null;
    setEvent(room, result);
    broadcast(room);
    scheduleTurn(room);
    return;
  }

  if (message.type === "set-settings") {
    if (player.id !== room.game.hostId || !allow(room, player.id, "settings", 5, 5000)) return;
    room.game.setSettings({
      lives: message.lives,
      turnSeconds: message.turnSeconds,
      difficulty: message.difficulty
    });
    broadcast(room);
    return;
  }

  if (message.type === "start") {
    if (player.id !== room.game.hostId) return;
    const result = room.game.start();
    if (!result.ok) return send(socket, { type: "feedback", level: "error", message: result.reason === "players" ? "Il faut au moins deux joueurs." : "La partie est déjà lancée." });
    room.liveInput = null;
    setEvent(room, { type: "start" });
    broadcast(room);
    scheduleTurn(room);
    return;
  }

  if (message.type === "play-again") {
    if (player.id !== room.game.hostId || room.game.phase !== "finished") return;
    room.game.resetForReplay();
    room.liveInput = null;
    setEvent(room, { type: "replay" });
    broadcast(room);
    return;
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, dictionarySize: lexicon.words.size }));
    return;
  }
  const requested = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream", "cache-control": "no-cache" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

const websocketServer = new WebSocketServer({ server, maxPayload: 8 * 1024 });
websocketServer.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      handleMessage(socket, JSON.parse(raw.toString("utf8")));
    } catch {
      send(socket, { type: "error", code: "BAD_MESSAGE", message: "Message invalide." });
    }
  });
  socket.on("close", () => {
    if (!socket.roomCode || !socket.playerId) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.sockets.get(socket.playerId) !== socket) return;
    room.sockets.delete(socket.playerId);
    disconnected(room, socket.playerId);
  });
  socket.on("error", () => socket.close());
});

server.listen(port, host, () => {
  console.log(`Bomb Party écoute sur http://${host}:${port} — ${lexicon.words.size} mots chargés`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

export { server, rooms, lexicon };

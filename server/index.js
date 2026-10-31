// Pac-Man Co-op game server: a small Node.js WebSocket server that hosts
// authoritative game rooms. Deploy it anywhere that supports long-lived
// WebSocket connections (Render, Fly.io, Railway, a VPS...). A static copy of
// the client (e.g. on GitHub Pages) can point at it via VITE_GAME_SERVER_URL.
//
// It can also serve the built client from ./dist, so a single deployment of
// this server is a complete game.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from '../shared/room.js';
import { TICK_DT, MAX_PLAYERS } from '../shared/constants.js';

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SIM_LAG_MS = Number(process.env.SIM_LAG_MS || 0);
const SIM_JITTER_MS = Number(process.env.SIM_JITTER_MS || 0);
// Jittered delays never reorder messages because each is >= the previous one's.
let lastDue = 0;
function lag() {
  const due = Math.max(lastDue, Date.now() + SIM_LAG_MS + Math.random() * SIM_JITTER_MS);
  lastDue = due;
  return due - Date.now();
}

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextPlayerId = 1;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function normalizeCode(c) {
  if (typeof c !== 'string') return '';
  c = c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length >= 3 ? c : '';
}

/** Room for a join request: explicit code, else the fullest public room with space. */
function findRoom(requested) {
  const code = normalizeCode(requested);
  if (code) {
    let room = rooms.get(code);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return { error: 'busy' };
      room = new Room({ code, isPublic: false });
      rooms.set(code, room);
    }
    if (room.full) return { error: 'full', code };
    return { room };
  }
  let best = null;
  for (const r of rooms.values()) {
    if (r.isPublic && !r.full && (!best || r.size > best.size)) best = r;
  }
  if (!best) {
    if (rooms.size >= MAX_ROOMS) return { error: 'busy' };
    best = new Room({ code: newCode(), isPublic: true });
    rooms.set(best.code, best);
  }
  return { room: best };
}

// ------------------------------------------------------------------ HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    let players = 0;
    for (const r of rooms.values()) players += r.size;
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  // Optional static hosting of the built client.
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Pac-Man Co-op game server is running. Connect via WebSocket at /ws');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: false, // lower latency/CPU; our messages are tiny
  verifyClient: ({ origin }) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin),
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let room = null;
  let playerId = null;
  // Simple flood protection: at most ~120 messages/second.
  let budget = 120;
  const refill = setInterval(() => (budget = 120), 1000);

  const rawSend = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  // SIM_LAG_MS adds artificial one-way latency (+/- jitter) for testing netcode.
  const send = SIM_LAG_MS ? (msg) => setTimeout(rawSend, lag(), msg) : rawSend;

  ws.on('message', (data) => (SIM_LAG_MS ? setTimeout(onMessage, lag(), data) : onMessage(data)));
  const onMessage = (data) => {
    if (--budget < 0) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!room) {
      if (msg.t !== 'hello') return;
      const found = findRoom(url.searchParams.get('room') || msg.room);
      if (found.error) {
        send({ t: 'error', code: found.error, room: found.code, max: MAX_PLAYERS });
        ws.close();
        return;
      }
      room = found.room;
      playerId = `p${nextPlayerId++}`;
      room.addPlayer(playerId, msg.profile, send);
      return;
    }
    room.handleMessage(playerId, msg);
  };

  ws.on('close', () => {
    clearInterval(refill);
    if (room && playerId) {
      room.removePlayer(playerId);
      if (room.size === 0) rooms.delete(room.code);
    }
  });
  ws.on('error', () => {});
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

// ------------------------------------------------------------ Game loop
// Fixed-timestep loop; catches up if the event loop stalls.

let last = performance.now();
let acc = 0;
function loop() {
  const now = performance.now();
  acc += Math.min(250, now - last);
  last = now;
  const stepMs = TICK_DT * 1000;
  while (acc >= stepMs) {
    for (const room of rooms.values()) {
      try {
        room.tick(TICK_DT);
      } catch (err) {
        console.error(`room ${room.code} tick failed`, err);
      }
    }
    acc -= stepMs;
  }
  setTimeout(loop, Math.max(1, stepMs - acc - 1));
}
loop();

server.listen(PORT, () => {
  console.log(`Pac-Man Co-op server listening on :${PORT} (ws path /ws)`);
});

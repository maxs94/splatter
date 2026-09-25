import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG as C, PALETTE } from './shared/game.js';
import { Room, send, MAX_PLAYERS, DEFAULT_BOTS } from './room.js';
import { prof } from './profiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- Static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(__dirname, 'shared');

const server = http.createServer((req, res) => {
  // Browser profiles (?profile) are uploaded here and saved next to the server's.
  if (req.method === 'POST' && req.url === '/api/client-profile') {
    if (!prof.enabled) { res.writeHead(403); return res.end('profiling is off (PROFILE=1)'); }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const { report, text } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        prof.saveClient(report, text);
        res.writeHead(204);
      } catch {
        res.writeHead(400);
      }
      res.end();
    });
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath === '/') urlPath = '/index.html';
  const isShared = urlPath.startsWith('/shared/');
  const root = isShared ? SHARED_DIR : PUBLIC_DIR;
  const file = path.normalize(path.join(root, isShared ? urlPath.slice('/shared'.length) : urlPath));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});


// ---------------------------------------------------------------- Rooms

// Every lobby is its own room with its own match; players browse the open rooms, then
// create one or join one.
const rooms = new Map(); // id -> Room
let nextRoomId = 1;
// Connections that picked a name and color. Those not in a room see the lobby browser.
const conns = new Set();
// Set when something the lobby browser shows changed; sent once per tick.
let roomsDirty = false;

// The profiler covers the time at least one match runs, over all rooms together.
let runningMatches = 0;
const totals = () => {
  const t = { rooms: rooms.size, humans: 0, bots: 0 };
  for (const r of rooms.values()) { t.humans += r.humanCount(); t.bots += r.botCount(); }
  return t;
};
const hooks = {
  changed: () => { roomsDirty = true; },
  matchStart: () => { if (runningMatches++ === 0) prof.matchStart(totals()); },
  matchEnd: reason => { if (--runningMatches === 0) prof.matchEnd(reason, totals()); },
};

const clean = (s, max) => String(s ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, max);

function roomList() {
  return { t: 'rooms', rooms: [...rooms.values()].map(r => r.summary()), max: MAX_PLAYERS };
}

function sendRooms() {
  roomsDirty = false;
  const data = JSON.stringify(roomList());
  let n = 0;
  for (const c of conns) {
    if (!c.room && c.ws.readyState === c.ws.OPEN) { c.ws.send(data); n++; }
  }
  prof.sent('rooms', data.length, n);
}

function enterRoom(conn, room) {
  if (!room || room.isFull()) {
    send(conn.ws, { t: 'joinFailed', reason: room ? 'full' : 'gone', max: MAX_PLAYERS });
    send(conn.ws, roomList());
    return;
  }
  conn.room = room;
  conn.player = room.addHuman(conn.ws, conn.name, conn.color, conn.cid);
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  room.removeHuman(conn.player);
  conn.room = conn.player = null;
  if (room.humanCount() === 0) {
    room.close();
    rooms.delete(room.id);
    console.log(`Room "${room.name}" closed, ${rooms.size} rooms open`);
  }
  roomsDirty = true;
}

// ---------------------------------------------------------------- Networking

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  // name, color and cid are set by 'hello'; room and player while in a room
  const conn = { ws, name: null, color: 0, cid: null, room: null, player: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m.t === 'string') prof.received(m.t, raw.length);
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello' && !conn.name) {
      // One player per browser: a hello with a known client id replaces the older
      // connection (another tab, or a refresh the server hasn't noticed yet).
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 64) : null;
      if (cid) {
        for (const other of [...conns]) {
          if (other.cid !== cid) continue;
          send(other.ws, { t: 'kicked', reason: 'tab' });
          leaveRoom(other);
          conns.delete(other);
          other.ws.close(4001, 'replaced');
        }
      }
      conn.cid = cid;
      conn.name = clean(m.name, 16) || `Player${Math.floor(Math.random() * 1000)}`;
      conn.color = Number.isInteger(m.color) && m.color >= 0 && m.color < PALETTE.length
        ? m.color : Math.floor(Math.random() * PALETTE.length);
      conns.add(conn);
      send(ws, roomList());
      return;
    }
    if (!conn.name) return;

    if (!conn.room) {
      if (m.t === 'create') {
        const name = String(m.name ?? '').replace(/[^\p{L}\p{N} _\-.!?']/gu, '').trim().slice(0, 24) || `${conn.name}'s game`;
        const bots = typeof m.bots === 'boolean' ? m.bots : DEFAULT_BOTS > 0;
        const room = new Room(String(nextRoomId++), name, bots, hooks);
        rooms.set(room.id, room);
        console.log(`Room "${name}" created by ${conn.name}, ${rooms.size} rooms open`);
        enterRoom(conn, room);
        roomsDirty = true;
      } else if (m.t === 'join') {
        enterRoom(conn, rooms.get(String(m.room)));
      }
      return;
    }

    if (m.t === 'leaveRoom') {
      leaveRoom(conn);
      send(ws, roomList());
    } else {
      conn.room.handle(conn.player, m);
    }
  });

  ws.on('close', () => {
    leaveRoom(conn);
    conns.delete(conn);
  });
});

// Drop connections that stopped answering (closed laptop, killed tab, lost network),
// so no ghost players stay in the lobby.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

// ---------------------------------------------------------------- Simulation

const STEP = 1 / C.TICK_RATE;
let last = performance.now();
let acc = 0;
let stateTimer = 0;

// One tick advances every room.
function simulate() {
  const tick = prof.tickStart();
  for (const room of rooms.values()) room.step(STEP);
  prof.tickEnd(tick);
}

setInterval(() => {
  const t = performance.now();
  acc += Math.min(0.25, (t - last) / 1000);
  last = t;
  let steps = 0;
  while (acc >= STEP) {
    simulate();
    acc -= STEP;
    stateTimer += STEP;
    steps++;
  }
  if (steps > 1) prof.count('loop.catchupSteps', steps - 1);
  if (stateTimer >= 1 / C.STATE_RATE) {
    const ts = prof.begin();
    stateTimer = 0;
    for (const room of rooms.values()) room.sendStates();
    prof.end('net.states', ts);
  }
  if (roomsDirty) sendRooms();
}, 1000 / C.TICK_RATE);

// Profiling: a sample every 5 s, and a report when the server stops.
if (prof.enabled) {
  setInterval(() => {
    if (runningMatches === 0) return;
    const g = { ...totals(), projectiles: 0, splats: 0 };
    for (const r of rooms.values()) { g.projectiles += r.projectiles.length; g.splats += r.splats.length; }
    prof.sample(g);
  }, 5000);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await prof.matchEnd('server stopped', totals());
      process.exit(0);
    });
  }
}

server.listen(PORT, () => console.log(`Splatter running on http://localhost:${PORT}`));

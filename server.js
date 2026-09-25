import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import { CONFIG as C, PALETTE } from './shared/game.js';
import { send, MAX_PLAYERS, DEFAULT_BOTS } from './room.js';
import { prof } from './profiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// CPUs this process may use. Containers limit CPUs with a cgroup quota, which Node's
// CPU count doesn't see (it reports the host's CPUs), so read the quota first.
function cpuCount() {
  const cpus = os.availableParallelism();
  const base = fs.existsSync('/cgroup') && fs.readdirSync('/cgroup').length ? '/cgroup' : '/sys/fs/cgroup';
  let quota = 0;
  try {
    const [q, period] = fs.readFileSync(`${base}/cpu.max`, 'utf8').trim().split(/\s+/); // cgroup v2
    if (q !== 'max') quota = Number(q) / Number(period);
  } catch {
    try { // cgroup v1
      const q = Number(fs.readFileSync(`${base}/cpu/cpu.cfs_quota_us`, 'utf8'));
      if (q > 0) quota = q / Number(fs.readFileSync(`${base}/cpu/cpu.cfs_period_us`, 'utf8'));
    } catch {}
  }
  return quota > 0 ? Math.max(1, Math.min(cpus, Math.floor(quota))) : cpus;
}
// Threads that run the rooms. Default: one per CPU, minus one for this thread, which
// handles all connections. Read again whenever a thread is needed, so a server that
// gets more CPUs uses them for new lobbies.
const roomThreads = () => Number(process.env.WORKERS) > 0
  ? Number(process.env.WORKERS)
  : Math.max(1, cpuCount() - 1);

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
// create one or join one. Rooms run in worker threads (room-worker.js), this thread
// keeps the list and forwards messages between the players and their room's thread.
const rooms = new Map(); // id -> { id, thread, members: Set<conn>, summary }
let nextRoomId = 1;
// Connections that picked a name and color. Those not in a room see the lobby browser.
const conns = new Map(); // id -> conn
let nextConnId = 1;
// Set when something the lobby browser shows changed; sent once per tick.
let roomsDirty = false;

// ---------------------------------------------------------------- Room threads

const threads = []; // { worker, rooms: Set<room id> }

function startThread() {
  const th = { worker: new Worker(new URL('./room-worker.js', import.meta.url)), rooms: new Set() };
  th.worker.on('message', msg => fromThread(th, msg));
  th.worker.on('error', err => console.error('Room thread failed:', err));
  th.worker.on('exit', () => threadExited(th));
  threads.push(th);
  console.log(`Room thread ${th.worker.threadId} started, ${threads.length} running`);
  return th;
}

// An idle thread, a new one while below the limit, or the one with the fewest rooms.
function pickThread() {
  const idle = threads.find(th => !th.rooms.size);
  if (idle) return idle;
  if (threads.length < roomThreads()) return startThread();
  return threads.reduce((a, b) => (b.rooms.size < a.rooms.size ? b : a));
}

function fromThread(th, msg) {
  if (msg.t === 'out') {
    for (const [roomId, data, ids] of msg.out) {
      for (const id of ids) {
        const c = conns.get(id);
        // Players who left the room already don't get its messages any more.
        if (c && c.room?.id === roomId && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
      }
    }
    for (const s of msg.summaries) {
      const r = rooms.get(s.id);
      if (r) { r.summary = s; roomsDirty = true; }
    }
  } else if (msg.t === 'stopped') {
    th.stopped?.();
  }
}

// A thread crashed: its rooms are gone, their players get disconnected.
function threadExited(th) {
  const i = threads.indexOf(th);
  if (i < 0) return; // stopped on purpose
  threads.splice(i, 1);
  for (const id of th.rooms) {
    const r = rooms.get(id);
    rooms.delete(id);
    for (const c of r?.members ?? []) {
      c.room = null;
      c.ws.close(1011, 'room failed');
    }
  }
  roomsDirty = true;
  console.error(`Room thread exited, closed ${th.rooms.size} rooms`);
}

function roomList() {
  return { t: 'rooms', rooms: [...rooms.values()].filter(r => r.summary).map(r => r.summary), max: MAX_PLAYERS };
}

function sendRooms() {
  roomsDirty = false;
  const data = JSON.stringify(roomList());
  for (const c of conns.values()) {
    if (!c.room && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

function createRoom(name, bots) {
  const th = pickThread();
  const room = { id: String(nextRoomId++), thread: th, members: new Set(), summary: null };
  rooms.set(room.id, room);
  th.rooms.add(room.id);
  th.worker.postMessage({ t: 'create', room: room.id, name, bots });
  console.log(`Room "${name}" created on thread ${th.worker.threadId}, ${rooms.size} rooms open`);
  return room;
}

// weapon, grenades: the loadout the player picked for their first life.
function enterRoom(conn, room, weapon, grenades) {
  if (!room || room.members.size >= MAX_PLAYERS) {
    send(conn.ws, { t: 'joinFailed', reason: room ? 'full' : 'gone', max: MAX_PLAYERS });
    send(conn.ws, roomList());
    return;
  }
  conn.room = room;
  room.members.add(conn);
  room.thread.worker.postMessage({ t: 'join', room: room.id, conn: conn.id, name: conn.name, color: conn.color, cid: conn.cid, weapon, grenades });
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;
  room.members.delete(conn);
  const th = room.thread;
  th.worker.postMessage({ t: 'leave', room: room.id, conn: conn.id });
  if (room.members.size === 0) {
    th.worker.postMessage({ t: 'close', room: room.id });
    th.rooms.delete(room.id);
    rooms.delete(room.id);
    console.log(`Room "${room.summary?.name ?? room.id}" closed, ${rooms.size} rooms open`);
    // Fewer CPUs than threads (or WORKERS lowered): let idle threads go.
    if (!th.rooms.size && threads.length > roomThreads()) {
      threads.splice(threads.indexOf(th), 1);
      th.worker.terminate();
    }
  }
  roomsDirty = true;
}

// ---------------------------------------------------------------- Networking

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  // name, color and cid are set by 'hello'; room while in a room
  const conn = { id: nextConnId++, ws, name: null, color: 0, cid: null, room: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;

    if (m.t === 'hello' && !conn.name) {
      // One player per browser: a hello with a known client id replaces the older
      // connection (another tab, or a refresh the server hasn't noticed yet).
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 64) : null;
      if (cid) {
        for (const other of [...conns.values()]) {
          if (other.cid !== cid) continue;
          send(other.ws, { t: 'kicked', reason: 'tab' });
          leaveRoom(other);
          conns.delete(other.id);
          other.ws.close(4001, 'replaced');
        }
      }
      conn.cid = cid;
      conn.name = String(m.name ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 16) || `Player${conn.id}`;
      conn.color = Number.isInteger(m.color) && m.color >= 0 && m.color < PALETTE.length
        ? m.color : Math.floor(Math.random() * PALETTE.length);
      conns.set(conn.id, conn);
      send(ws, roomList());
      return;
    }
    if (!conn.name) return;

    if (!conn.room) {
      if (m.t === 'create') {
        const name = String(m.name ?? '').replace(/[^\p{L}\p{N} _\-.!?']/gu, '').trim().slice(0, 24) || `${conn.name}'s game`;
        const bots = typeof m.bots === 'boolean' ? m.bots : DEFAULT_BOTS > 0;
        enterRoom(conn, createRoom(name, bots), m.weapon, m.grenades);
      } else if (m.t === 'join') {
        enterRoom(conn, rooms.get(String(m.room)), m.weapon, m.grenades);
      }
      return;
    }

    if (m.t === 'leaveRoom') {
      leaveRoom(conn);
      send(ws, roomList());
    } else {
      conn.room.thread.worker.postMessage({ t: 'msg', room: conn.room.id, conn: conn.id, m, len: raw.length });
    }
  });

  ws.on('close', () => {
    leaveRoom(conn);
    conns.delete(conn.id);
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

setInterval(() => {
  if (roomsDirty) sendRooms();
}, 1000 / C.TICK_RATE);

// Profiling: every room thread writes its report when the server stops.
if (prof.enabled) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await Promise.all(threads.map(th => new Promise(done => {
        th.stopped = done;
        th.worker.postMessage({ t: 'stop' });
        setTimeout(done, 5000);
      })));
      process.exit(0);
    });
  }
}

// Start the threads right away, so creating a lobby doesn't wait for one to boot.
while (threads.length < roomThreads()) startThread();

server.listen(PORT, () => console.log(`Splatter running on http://localhost:${PORT}, up to ${roomThreads()} room threads`));

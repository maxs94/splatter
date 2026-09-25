// A thread that runs rooms, so several matches use several CPUs. The main thread
// (server.js) keeps the connections and the lobby list: it tells this thread about
// rooms, players and their messages, and sends out what the rooms send to players.

import { parentPort } from 'node:worker_threads';
import { CONFIG as C } from './shared/game.js';
import { Room, prepare } from './room.js';
import { prof } from './profiler.js';

const rooms = new Map(); // room id -> { room, players: Map<connection id, player> }

// Build the navigation graph now, not when the first player waits for their room.
prepare();

// What the rooms send to players, posted to the main thread in one batch once the
// current tick or message is handled: [room id, data, [connection ids]].
let outbox = [];
const changed = new Set(); // rooms whose lobby browser summary changed
let flushQueued = false;

function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

function flush() {
  flushQueued = false;
  const summaries = [];
  for (const id of changed) if (rooms.has(id)) summaries.push(rooms.get(id).room.summary());
  changed.clear();
  if (outbox.length || summaries.length) parentPort.postMessage({ t: 'out', out: outbox, summaries });
  outbox = [];
}

// Stands in for a player's WebSocket inside the room. A broadcast sends the same data
// to every player in a row, so it goes out as one entry.
function connection(roomId, connId) {
  return {
    OPEN: 1, readyState: 1,
    send(data) {
      const last = outbox[outbox.length - 1];
      if (last && last[0] === roomId && last[1] === data) last[2].push(connId);
      else outbox.push([roomId, data, [connId]]);
      queueFlush();
    },
  };
}

// The profiler covers the time at least one match of this thread runs.
let runningMatches = 0;
const totals = () => {
  const t = { rooms: rooms.size, humans: 0, bots: 0 };
  for (const { room } of rooms.values()) { t.humans += room.humanCount(); t.bots += room.botCount(); }
  return t;
};

function hooks(id) {
  return {
    changed: () => { changed.add(id); queueFlush(); },
    matchStart: () => { if (runningMatches++ === 0) prof.matchStart(totals()); },
    matchEnd: reason => { if (--runningMatches === 0) prof.matchEnd(reason, totals()); },
  };
}

parentPort.on('message', async msg => {
  const e = rooms.get(msg.room);
  switch (msg.t) {
    case 'create':
      rooms.set(msg.room, { room: new Room(msg.room, msg.name, msg.bots, hooks(msg.room)), players: new Map() });
      break;
    case 'join':
      if (e) e.players.set(msg.conn, e.room.addHuman(connection(msg.room, msg.conn), msg.name, msg.color, msg.cid, msg.weapon));
      break;
    case 'leave': {
      const p = e?.players.get(msg.conn);
      if (!p) break;
      e.players.delete(msg.conn);
      e.room.removeHuman(p);
      break;
    }
    case 'close':
      if (e) { e.room.close(); rooms.delete(msg.room); }
      break;
    case 'msg': {
      prof.received(msg.m.t, msg.len);
      const p = e?.players.get(msg.conn);
      if (p) e.room.handle(p, msg.m);
      break;
    }
    case 'stop':
      // The server stops: write the running profile first.
      await prof.matchEnd('server stopped', totals());
      parentPort.postMessage({ t: 'stopped' });
      break;
  }
});

// ---------------------------------------------------------------- Simulation

const STEP = 1 / C.TICK_RATE;
let last = performance.now();
let acc = 0;
let stateTimer = 0;

// One tick advances every room of this thread.
function simulate() {
  const tick = prof.tickStart();
  for (const { room } of rooms.values()) room.step(STEP);
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
    for (const { room } of rooms.values()) room.sendStates();
    prof.end('net.states', ts);
  }
}, 1000 / C.TICK_RATE);

// Profiling: a sample every 5 s while a match runs.
if (prof.enabled) {
  setInterval(() => {
    if (runningMatches === 0) return;
    const g = { ...totals(), projectiles: 0, splats: 0 };
    for (const { room } of rooms.values()) { g.projectiles += room.projectiles.length; g.splats += room.splats.length; }
    prof.sample(g);
  }, 5000);
}

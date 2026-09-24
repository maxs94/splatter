import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  CONFIG as C, PALETTE, LEVEL, segBox, stepProjectile, hitPoint, groundHeight,
} from './shared/game.js';
import { NavGraph } from './bots/nav.js';
import { Bot, BOT_NAMES } from './bots/brain.js';
import { prof } from './profiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Bots fill the arena up to this many players while at least one human is connected.
// A match holds at most this many players, humans and bots together.
const MAX_PLAYERS = 10;
// Default number of bots for a new lobby; the lobby leader can change it.
const DEFAULT_BOTS = Math.min(MAX_PLAYERS - 1, Math.max(0, Number(process.env.BOTS ?? 3)));
// Bot skill 0..1, each bot gets a bit of random variation around it.
const BOT_SKILL = Math.min(1, Math.max(0, Number(process.env.BOT_SKILL ?? 0.4)));

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

// ---------------------------------------------------------------- Game state

const players = new Map();
const projectiles = [];
let splats = [];
let nextPlayerId = 1;
let nextProjectileId = 1;
// Match flow: lobby -> loading (clients load the level) -> countdown -> playing -> ended -> lobby
const game = { phase: 'lobby', until: 0 };
// Lobby settings chosen by the leader.
const settings = { bots: DEFAULT_BOTS > 0, botCount: Math.max(1, DEFAULT_BOTS) };
const inMatch = () => game.phase !== 'lobby';

const r3 = x => Math.round(x * 1000) / 1000;
const vec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const seed = () => (Math.random() * 0x7fffffff) | 0;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    const data = JSON.stringify(msg);
    ws.send(data);
    prof.sent(msg.t, data.length);
  }
}
function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  let n = 0;
  for (const p of players.values()) {
    if (p.id !== exceptId && p.ws && p.ws.readyState === p.ws.OPEN) { p.ws.send(data); n++; }
  }
  prof.sent(msg.t, data.length, n);
}

const humans = () => [...players.values()].filter(p => !p.bot);
const humanCount = () => humans().length;
// The longest connected human leads the lobby.
const leaderId = () => humans().reduce((best, p) => (best === null || p.id < best ? p.id : best), null);

function makePlayer(id, ws, name, color) {
  return {
    id, ws, name, color, p: pickSpawn(id), v: [0, 0, 0], onGround: false, yaw: 0, pitch: 0,
    hp: C.MAX_HP, alive: false, life: 0, kills: 0, deaths: 0, respawnAt: 0, lastShot: 0,
    lastDamage: 0, sentHp: C.MAX_HP, paintHits: 0, ready: false, bot: null,
  };
}

function lobbyInfo() {
  return {
    t: 'lobby', phase: game.phase, leader: leaderId(),
    players: humans().map(p => ({ id: p.id, name: p.name, color: p.color })),
    settings: { ...settings, maxPlayers: MAX_PLAYERS },
  };
}

function publicInfo(p) {
  return { id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, alive: p.alive, p: p.p.map(r3), yaw: p.yaw };
}

function roundInfo() {
  return { state: game.phase, remaining: Math.max(0, game.until - Date.now()) };
}

function matchState() {
  return { players: [...players.values()].map(publicInfo), splats, round: roundInfo() };
}

function scores() {
  return [...players.values()]
    .map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
}

// Spawn point furthest from living opponents, with a bit of randomness among the best.
function pickSpawn(forId) {
  const others = [...players.values()].filter(p => p.alive && p.id !== forId);
  const ranked = LEVEL.spawns
    .map(s => ({ s, d: others.length ? Math.min(...others.map(o => Math.hypot(o.p[0] - s[0], o.p[2] - s[2]))) : Math.random() }))
    .sort((a, b) => b.d - a.d);
  return ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].s.slice();
}

function addSplat(sp) {
  splats.push(sp);
  if (splats.length > C.MAX_SPLATS) splats.splice(0, splats.length - C.MAX_SPLATS);
  broadcast({ t: 'splat', ...sp });
}

function respawn(p) {
  p.p = pickSpawn(p.id);
  p.v = [0, 0, 0];
  p.hp = p.sentHp = C.MAX_HP;
  p.alive = true;
  p.paintHits = 0;
  p.life++;
  if (p.bot) p.bot.onRespawn();
  broadcast({ t: 'respawn', id: p.id, p: p.p, life: p.life });
}

function kill(victim, killerId) {
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = Date.now() + C.RESPAWN_TIME * 1000;
  const killer = players.get(killerId);
  if (killer) killer.kills++;
  if (victim.bot) victim.bot.onDeath();
  for (const p of players.values()) if (p.bot) p.bot.forget(victim.id);
  broadcast({
    t: 'kill', killer: killerId, victim: victim.id,
    kk: killer ? killer.kills : 0, vd: victim.deaths,
  });
  // Big splat of the killer's color where the victim fell.
  const [x, y, z] = victim.p;
  addSplat({
    id: 0, p: [r3(x), r3(groundHeight(x, z, y + 0.5)), r3(z)], a: 1, sg: 1,
    c: killer ? killer.color : victim.color, r: r3(C.SPLAT_RADIUS * 2.2), s: seed(),
  });
}

function setPhase(phase, seconds = 0) {
  game.phase = phase;
  game.until = Date.now() + seconds * 1000;
}

// Leader pressed start: everybody loads the level, the countdown starts once all are ready.
function startMatch() {
  splats = [];
  projectiles.length = 0;
  for (const p of players.values()) {
    p.kills = 0; p.deaths = 0; p.ready = false; p.alive = false;
  }
  setPhase('loading', C.LOADING_TIMEOUT);
  broadcast({ t: 'start', ...matchState() });
  console.log(`Match starting with ${humanCount()} humans`);
}

function beginCountdown() {
  setPhase('countdown', C.COUNTDOWN);
  maintainBots();
  prof.matchStart({ humans: humanCount(), bots: players.size - humanCount() });
  for (const p of players.values()) respawn(p);
  broadcast({ t: 'round', round: roundInfo() });
}

function returnToLobby() {
  prof.matchEnd('back to lobby', { humans: humanCount(), bots: players.size - humanCount() });
  projectiles.length = 0;
  setPhase('lobby');
  for (const p of [...players.values()]) {
    if (p.bot) removeBot(p);
    else { p.alive = false; p.ready = false; }
  }
  broadcast(lobbyInfo());
}

function fire(pl, o, d) {
  const now = Date.now();
  if (!pl.alive || game.phase !== 'playing') return null;
  if (now - pl.lastShot < C.FIRE_INTERVAL * 1000 - 40) return null;
  pl.lastShot = now;
  const pr = {
    id: nextProjectileId++, owner: pl.id, color: pl.color, born: now,
    p: o.slice(), v: d.map(x => x * C.BLOB_SPEED),
  };
  projectiles.push(pr);
  broadcast({ t: 'shot', id: pr.id, owner: pl.id, c: pl.color, o: o.map(r3), v: pr.v.map(r3) }, pl.id);
  for (const p of players.values()) if (p.bot) p.bot.onShot(pl, o);
  return pr;
}

// ---------------------------------------------------------------- Bots

const nav = new NavGraph();
const botGame = { players, nav, fire, isPlaying: () => game.phase === 'playing' };

function addBot() {
  const id = nextPlayerId++;
  const used = new Set([...players.values()].map(p => p.color));
  const free = PALETTE.map((_, i) => i).filter(i => !used.has(i));
  const color = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * PALETTE.length);
  const taken = new Set([...players.values()].map(p => p.name));
  const names = BOT_NAMES.map(n => `Bot ${n}`).filter(n => !taken.has(n));
  const name = names.length ? names[Math.floor(Math.random() * names.length)] : `Bot ${id}`;
  const pl = makePlayer(id, null, name, color);
  pl.yaw = Math.atan2(pl.p[0], pl.p[2]);
  pl.bot = new Bot(pl, botGame, Math.min(1, Math.max(0, BOT_SKILL + (Math.random() - 0.5) * 0.3)));
  players.set(id, pl);
  broadcast({ t: 'join', player: publicInfo(pl) });
  // Bots that fill in mid-match spawn right away; at match start everyone spawns together.
  if (game.phase === 'playing') respawn(pl);
}

function removeBot(pl) {
  players.delete(pl.id);
  broadcast({ t: 'leave', id: pl.id });
}

function maintainBots() {
  const humans = humanCount();
  const bots = [...players.values()].filter(p => p.bot);
  const active = game.phase === 'countdown' || game.phase === 'playing' || game.phase === 'ended';
  // The leader's bot count, capped so humans and bots never exceed MAX_PLAYERS:
  // a human joining a full match takes a bot's place.
  const want = humans > 0 && active && settings.bots ? Math.max(0, Math.min(settings.botCount, MAX_PLAYERS - humans)) : 0;
  for (let i = bots.length; i < want; i++) addBot();
  for (let i = want; i < bots.length; i++) removeBot(bots[i]);
}

// ---------------------------------------------------------------- Networking

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

// Removes a human player and tells everybody.
function removeHuman(pl) {
  if (players.get(pl.id) !== pl) return; // already gone
  players.delete(pl.id);
  broadcast({ t: 'leave', id: pl.id });
  console.log(`- ${pl.name} (#${pl.id}) left, ${humanCount()} humans online`);
  if (humanCount() === 0) returnToLobby();
  else {
    maintainBots();
    broadcast(lobbyInfo());
  }
}

wss.on('connection', ws => {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m.t === 'string') prof.received(m.t, raw.length);
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !me) {
      // One player per browser: a join with a known client id replaces the older
      // connection (another tab, or a refresh the server hasn't noticed yet).
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 64) : null;
      if (cid) {
        for (const other of [...players.values()]) {
          if (other.bot || other.cid !== cid) continue;
          send(other.ws, { t: 'kicked', reason: 'tab' });
          removeHuman(other);
          other.ws.close(4001, 'replaced');
        }
      }
      if (humanCount() >= MAX_PLAYERS) {
        send(ws, { t: 'full', max: MAX_PLAYERS });
        ws.close(4002, 'full');
        return;
      }
      const id = nextPlayerId++;
      const name = String(m.name ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 16) || `Player${id}`;
      const color = Number.isInteger(m.color) && m.color >= 0 && m.color < PALETTE.length
        ? m.color : Math.floor(Math.random() * PALETTE.length);
      me = makePlayer(id, ws, name, color);
      me.cid = cid;
      players.set(id, me);
      if (inMatch()) {
        // Drop in to the running match.
        send(ws, { t: 'welcome', id, life: me.life, phase: game.phase, ...matchState() });
        broadcast({ t: 'join', player: publicInfo(me) }, id);
        if (game.phase === 'countdown' || game.phase === 'playing') respawn(me);
        maintainBots();
      } else {
        send(ws, { t: 'welcome', id, life: me.life, phase: game.phase });
      }
      broadcast(lobbyInfo());
      console.log(`+ ${name} (#${id}) joined, ${humanCount()} humans online`);
      return;
    }
    if (!me) return;

    if (m.t === 'start') {
      if (game.phase === 'lobby' && me.id === leaderId()) startMatch();
    } else if (m.t === 'settings') {
      if (game.phase !== 'lobby' || me.id !== leaderId()) return;
      if (typeof m.bots === 'boolean') settings.bots = m.bots;
      if (Number.isInteger(m.botCount)) settings.botCount = Math.min(MAX_PLAYERS - 1, Math.max(1, m.botCount));
      broadcast(lobbyInfo());
    } else if (m.t === 'ready') {
      me.ready = true;
    } else if (m.t === 's') {
      if (!me.alive || m.l !== me.life || !vec(m.p) || !Number.isFinite(m.y) || !Number.isFinite(m.x)) return;
      const lim = LEVEL.half;
      me.p = [
        Math.max(-lim, Math.min(lim, m.p[0])),
        Math.max(-5, Math.min(20, m.p[1])),
        Math.max(-lim, Math.min(lim, m.p[2])),
      ];
      me.yaw = m.y;
      me.pitch = m.x;
    } else if (m.t === 'shoot') {
      if (!vec(m.o) || !vec(m.d)) return;
      const len = Math.hypot(...m.d);
      if (len < 1e-6) return;
      const d = m.d.map(x => x / len);
      const eye = [me.p[0], me.p[1] + C.EYE_HEIGHT, me.p[2]];
      const o = Math.hypot(m.o[0] - eye[0], m.o[1] - eye[1], m.o[2] - eye[2]) < 3
        ? m.o.slice()
        : eye.map((e, i) => e + d[i] * C.MUZZLE_OFFSET);
      const pr = fire(me, o, d);
      if (pr) send(ws, { t: 'ack', cid: m.cid, id: pr.id });
    }
  });

  ws.on('close', () => {
    if (me) removeHuman(me);
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

function simulate() {
  const tick = prof.tickStart();
  simulateStep();
  prof.tickEnd(tick);
}

function simulateStep() {
  const now = Date.now();

  if (game.phase === 'playing') {
    const t = prof.begin();
    for (const p of players.values()) if (p.bot) p.bot.update(STEP);
    prof.end('bots', t);
  }
  const tp = prof.begin();

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    const { o, s, hit } = stepProjectile(pr, STEP);

    let ph = null;
    for (const pl of players.values()) {
      if (pl.id === pr.owner || !pl.alive) continue;
      const r = C.PLAYER_RADIUS;
      const h = segBox(o, s, [pl.p[0] - r, pl.p[1], pl.p[2] - r], [pl.p[0] + r, pl.p[1] + C.PLAYER_HEIGHT, pl.p[2] + r], C.BLOB_RADIUS);
      if (h && (!ph || h.t < ph.t)) ph = { ...h, pl };
    }

    if (ph && (!hit || ph.t <= hit.t)) {
      projectiles.splice(i, 1);
      const q = hitPoint(o, s, ph);
      const target = ph.pl;
      target.hp -= C.DAMAGE;
      target.lastDamage = now;
      target.sentHp = Math.max(0, target.hp);
      target.paintHits++;
      if (target.bot) target.bot.onHurt(players.get(pr.owner), pr.v);
      broadcast({
        t: 'hitp', id: pr.id, owner: pr.owner, target: target.id, c: pr.color, s: seed(),
        off: [r3(q[0] - target.p[0]), r3(q[1] - target.p[1]), r3(q[2] - target.p[2])],
        yaw: r3(target.yaw), hp: Math.max(0, target.hp),
        dir: pr.v.map(x => r3(x / C.BLOB_SPEED)), // for the ragdoll push
      });
      if (target.hp <= 0) kill(target, pr.owner);
    } else if (hit) {
      projectiles.splice(i, 1);
      const q = hitPoint(o, s, hit);
      addSplat({
        id: pr.id, p: q.map(r3), a: hit.axis, sg: hit.sign, c: pr.color,
        r: r3(C.SPLAT_RADIUS * (0.85 + Math.random() * 0.3)), s: seed(),
      });
    } else if (now - pr.born > C.BLOB_LIFETIME * 1000 || pr.p[1] < -10) {
      projectiles.splice(i, 1);
    }
  }

  if (game.phase !== 'playing') {
    if (game.phase === 'loading' && (humans().every(p => p.ready) || now >= game.until)) beginCountdown();
    else if (game.phase === 'countdown' && now >= game.until) {
      setPhase('playing', C.ROUND_TIME);
      broadcast({ t: 'round', round: roundInfo() });
    } else if (game.phase === 'ended' && now >= game.until) returnToLobby();
    return;
  }

  prof.end('projectiles', tp);
  prof.count('projectiles.stepped', projectiles.length);

  for (const p of players.values()) {
    if (!p.alive && now >= p.respawnAt) respawn(p);
    // Health regenerates after a while without damage.
    if (p.alive && p.hp < C.MAX_HP && now - p.lastDamage > C.REGEN_DELAY * 1000) {
      p.hp = Math.min(C.MAX_HP, p.hp + C.REGEN_RATE * STEP);
      if (!p.bot && (p.hp - p.sentHp >= 5 || p.hp === C.MAX_HP) && p.sentHp !== p.hp) {
        p.sentHp = p.hp;
        send(p.ws, { t: 'hp', hp: Math.round(p.hp) });
      }
    }
  }

  if (now >= game.until) {
    setPhase('ended', C.INTERMISSION);
    projectiles.length = 0;
    broadcast({ t: 'round', round: roundInfo(), scores: scores() });
    prof.matchEnd('match ended', { humans: humanCount(), bots: players.size - humanCount() });
  }
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
    const l = [];
    for (const p of players.values()) {
      if (p.alive) l.push([p.id, r3(p.p[0]), r3(p.p[1]), r3(p.p[2]), r3(p.yaw), r3(p.pitch)]);
    }
    if (l.length) broadcast({ t: 'st', l });
    prof.end('net.states', ts);
  }
}, 1000 / C.TICK_RATE);

// Profiling: a sample every 5 s, and a report when the server stops.
if (prof.enabled) {
  setInterval(() => {
    if (game.phase !== 'playing' && game.phase !== 'countdown') return;
    prof.sample({
      humans: humanCount(), bots: players.size - humanCount(),
      projectiles: projectiles.length, splats: splats.length,
    });
  }, 5000);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await prof.matchEnd('server stopped', { humans: humanCount(), bots: players.size - humanCount() });
      process.exit(0);
    });
  }
}

server.listen(PORT, () => console.log(`Splatter running on http://localhost:${PORT}`));

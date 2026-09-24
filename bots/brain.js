// Server-side bot: perception -> memory -> HTN plan -> behaviors -> movement and aim.
//
// Bots play by the same rules as humans. They cannot see an unpainted player unless
// they are very close; paint on a player, a fired shot or recent tracking make a
// player visible. They also hear shots and feel roughly where a hit came from.

import { CONFIG as C, lineOfSight, movePlayer } from '../shared/game.js';
import { Domain, plan, task as t } from './htn.js';
import { prof } from '../profiler.js';

// line of sight, counted for profiling
const los = (a, b) => { prof.count('bot.lineOfSight'); return lineOfSight(a, b); };

const TAU = Math.PI * 2;
const DEBUG = !!process.env.BOT_DEBUG;

const SENSE = {
  visionRange: 45,
  fovCos: Math.cos((55 * Math.PI) / 180), // 110 degree field of view
  hearingRange: 32,
  memoryMs: 9000,   // how long a lost or heard enemy stays interesting
  trackGraceMs: 700, // keep tracking a seen enemy through short perception misses
  interval: 0.2,    // perception and replanning rate in seconds
};

export const BOT_NAMES = ['Blotch', 'Drip', 'Smudge', 'Splodge', 'Dribble', 'Speckle', 'Smear', 'Gloop'];

// ---------------------------------------------------------------- Math helpers

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const gauss = () => {
  let u = 0;
  while (!u) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * Math.random());
};
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const eye = p => [p[0], p[1] + C.EYE_HEIGHT, p[2]];
const chest = p => [p[0], p[1] + 1.15, p[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dirOf = (yaw, pitch) => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
const jitter = (p, r) => [p[0] + gauss() * r, p[1], p[2] + gauss() * r];

function inView(from, yaw, pitch, point) {
  const d = dist(from, point);
  if (d < 1e-6) return true;
  const look = dirOf(yaw, pitch);
  const dot = ((point[0] - from[0]) * look[0] + (point[1] - from[1]) * look[1] + (point[2] - from[2]) * look[2]) / d;
  return dot > SENSE.fovCos;
}

// Launch angle to hit a point dx away horizontally and dy higher (low arc).
function ballisticPitch(dx, dy) {
  if (dx < 0.5) return Math.atan2(dy, Math.max(dx, 1e-3));
  const v2 = C.BLOB_SPEED * C.BLOB_SPEED, g = C.BLOB_GRAVITY;
  const disc = v2 * v2 - g * (g * dx * dx + 2 * dy * v2);
  if (disc < 0) return Math.PI / 4;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * dx));
}

// ---------------------------------------------------------------- HTN domain

const D = new Domain();

// Root task. Methods are ordered by priority; a running plan is interrupted when a
// higher-priority method becomes applicable.
D.method('Live', 'retreat', ws => ws.cover && ws.retreatReady, ws => [
  t('MarkRetreat'),
  t('MoveTo', { pos: ws.cover, look: ws.dangerPos }),
  t('Wait', { time: rand(0.6, 1.4) }),
  t('TurnTo', { pos: chest(ws.dangerPos) }),
]);
D.method('Live', 'engage', ws => ws.enemy != null, ws => [t('Engage', { id: ws.enemy })]);
D.method('Live', 'counter', ws => ws.hurtFrom != null, ws => [
  t('TurnTo', { pos: chest(ws.hurtFrom) }),
  t('SprayArea', { pos: ws.hurtFrom, shots: 4, spread: 2.5, clearHurt: true }),
]);
D.method('Live', 'investigate', ws => ws.threat != null, ws => [t('Investigate', { threat: ws.threat })]);
D.method('Live', 'patrol', () => true, () => [t('Patrol')]);

D.method('Engage', 'close in', ws => ws.enemyDist > 24, (ws, a) => [
  ...(ws.enemyFresh ? [t('React', { id: a.id })] : []),
  t('Approach', { id: a.id }),
]);
D.method('Engage', 'fight fresh', ws => ws.enemyFresh, (ws, a) => [
  t('React', { id: a.id }),
  t('AimAt', { id: a.id }),
  t('FireBurst', { id: a.id }),
]);
D.method('Engage', 'fight', () => true, (ws, a) => [t('AimAt', { id: a.id }), t('FireBurst', { id: a.id })]);

// Close by: paint the spot to reveal whoever is there. Far away: walk over first.
D.method('Investigate', 'paint the spot', (ws, a) => a.threat.dist < 16, (ws, a) => [
  t('TurnTo', { pos: chest(a.threat.pos) }),
  t('SprayArea', { pos: a.threat.pos, shots: 3, spread: 3, investigate: a.threat.id }),
  t('LookAround', { time: 1.2 }),
]);
D.method('Investigate', 'move closer', () => true, (ws, a) => [
  t('MoveTo', { pos: a.threat.pos, stopDist: 10, look: chest(a.threat.pos) }),
  t('SprayArea', { pos: a.threat.pos, shots: 3, spread: 3, investigate: a.threat.id }),
]);

// Nothing known: either paint the surroundings to see the level, or wander.
D.method('Patrol', 'reveal', ws => ws.revealPoint && ws.roll < 0.35, ws => [
  t('SprayArea', { pos: ws.revealPoint, shots: randInt(3, 5), spread: 4 }),
  t('LookAround', { time: 1 }),
]);
D.method('Patrol', 'wander', ws => ws.wanderPoint, ws => [
  t('MoveTo', { pos: ws.wanderPoint }),
  t('LookAround', { time: rand(0.8, 2) }),
]);

const hasEnemy = (ws, a) => ws.enemy === a.id;
const hasPos = (ws, a) => a.pos != null;
D.operator('MarkRetreat', { effect: ws => { ws.retreatReady = false; } });
D.operator('MoveTo', { cond: hasPos, effect: (ws, a) => { ws.at = a.pos; } });
D.operator('Wait');
D.operator('TurnTo', { cond: hasPos });
D.operator('LookAround');
D.operator('React', { cond: hasEnemy, effect: ws => { ws.enemyFresh = false; } });
D.operator('AimAt', { cond: hasEnemy });
D.operator('FireBurst', { cond: hasEnemy });
D.operator('Approach', { cond: hasEnemy });
D.operator('SprayArea', {
  cond: hasPos,
  effect: (ws, a) => {
    if (a.investigate != null) ws.threat = null;
    if (a.clearHurt) ws.hurtFrom = null;
  },
});

const ROOT = D.methods('Live');

// ---------------------------------------------------------------- Behaviors
// Each primitive task runs as a generator on the bot: yield = keep running next tick,
// return true = success, return false = failure (triggers a replan).

const BEHAVIORS = {
  *MarkRetreat() {
    this.lastRetreat = this.now();
    return true;
  },

  *Wait({ time }) {
    const end = this.now() + time * 1000;
    while (this.now() < end) yield;
    return true;
  },

  *TurnTo({ pos }) {
    const end = this.now() + 1500;
    while (this.now() < end) {
      this.lookAt(pos);
      if (this.aimError() < 0.1) return true;
      yield;
    }
    return true;
  },

  *LookAround({ time }) {
    const end = this.now() + time * 1000;
    let next = 0;
    while (this.now() < end) {
      if (this.now() >= next) {
        this.wantYaw = this.pl.yaw + rand(-1.3, 1.3);
        this.wantPitch = rand(-0.15, 0.05);
        next = this.now() + rand(500, 900);
      }
      yield;
    }
    return true;
  },

  *MoveTo({ pos, look, stopDist = 1 }) {
    const route = this.route(pos);
    if (!route) return false;
    let best = Infinity, lastProgress = this.now();
    for (;;) {
      const remaining = hdist(this.pl.p, pos);
      if (remaining < stopDist || !this.follow(route)) return true;
      if (look) this.lookAt(look); else this.lookAlong();
      if (remaining < best - 0.3) { best = remaining; lastProgress = this.now(); }
      if (this.now() - lastProgress > 2500) return false;
      yield;
    }
  },

  *React({ id }) {
    const m = this.memory.get(id);
    const end = this.now() + rand(350, 750) * (1.3 - this.skill);
    while (this.now() < end) {
      const q = this.game.players.get(id);
      if (!m || !q || !q.alive) return false;
      this.lookAt(chest(m.visible ? q.p : m.pos));
      yield;
    }
    m.reacted = true;
    return true;
  },

  *AimAt({ id }) {
    this.rangeErr = 1 + gauss() * 0.12 * (1 - this.skill);
    const end = this.now() + 1500;
    while (this.now() < end) {
      const q = this.game.players.get(id), m = this.memory.get(id);
      if (!q || !q.alive || !m || !m.visible) return false;
      this.aimAtTarget(q, m);
      if (this.aimError() < 0.15) return true;
      yield;
    }
    return false;
  },

  *FireBurst({ id }) {
    let shots = randInt(2, 5);
    let pauseUntil = 0;
    let strafe = Math.random() < 0.5 ? -1 : 1;
    let switchAt = this.now() + rand(400, 1200);
    const strafes = Math.random() < 0.3 + 0.5 * this.skill;
    for (;;) {
      const q = this.game.players.get(id), m = this.memory.get(id);
      if (!q || !q.alive || !m) return true;
      if (!m.visible) return false;
      this.aimAtTarget(q, m);
      if (strafes) {
        if (this.now() > switchAt) { strafe = -strafe; switchAt = this.now() + rand(400, 1200); }
        const dx = q.p[0] - this.pl.p[0], dz = q.p[2] - this.pl.p[2], l = Math.hypot(dx, dz) || 1;
        this.moveDir = [(-dz / l) * strafe, (dx / l) * strafe];
      }
      if (pauseUntil) {
        if (this.now() >= pauseUntil) return true;
      } else if (this.tryFire() && --shots <= 0) {
        pauseUntil = this.now() + rand(200, 700);
      }
      yield;
    }
  },

  *Approach({ id }) {
    const end = this.now() + 4000;
    let route = null, repathAt = 0;
    while (this.now() < end) {
      const q = this.game.players.get(id), m = this.memory.get(id);
      if (!q || !q.alive || !m) return false;
      if (!m.visible || hdist(this.pl.p, q.p) < 18) return true;
      if (this.now() > repathAt) {
        route = this.route(q.p);
        repathAt = this.now() + 1000;
        if (!route) return false;
      }
      this.follow(route);
      this.aimAtTarget(q, m);
      this.tryFire();
      yield;
    }
    return true;
  },

  *SprayArea({ pos, shots, spread, investigate, clearHurt }) {
    let left = shots, target = null;
    const end = this.now() + 5000;
    while (left > 0 && this.now() < end) {
      if (!target) target = [pos[0] + gauss() * spread, Math.max(0.2, pos[1] + rand(0, 1.8)), pos[2] + gauss() * spread];
      this.aimBallistic(target);
      if (this.tryFire()) { left--; target = null; }
      yield;
    }
    if (investigate != null) {
      const m = this.memory.get(investigate);
      if (m) m.investigated = true;
    }
    if (clearHurt) this.hurt = null;
    return true;
  },
};

// ---------------------------------------------------------------- Bot

export class Bot {
  // game: { players: Map, nav: NavGraph, fire(player, origin, dir), isPlaying() }
  constructor(pl, game, skill) {
    this.pl = pl;
    this.game = game;
    this.nav = game.nav;
    this.skill = skill;
    this.reset();
  }

  now() { return Date.now(); }

  reset() {
    this.memory = new Map();
    this.hurt = null;
    this.plan = null;
    this.step = 0;
    this.gen = null;
    this.rootIndex = Infinity;
    this.lastRetreat = -Infinity;
    this.senseTimer = 0;
    this.moveDir = null;
    this.wantYaw = this.pl.yaw;
    this.wantPitch = 0;
    this.nextShot = 0;
    this.stuckTime = 0;
    this.rangeErr = 1;
  }

  // ------------------------------------------------ Events from the server

  onRespawn() {
    this.reset();
    this.pl.yaw = this.wantYaw = Math.atan2(this.pl.p[0], this.pl.p[2]);
    this.pl.pitch = 0;
  }

  onDeath() {
    this.plan = null;
    this.gen = null;
  }

  forget(id) {
    this.memory.delete(id);
  }

  onShot(shooter, origin) {
    if (!this.pl.alive || shooter === this.pl) return;
    const m = this.memory.get(shooter.id);
    if (m && m.visible) return;
    const e = eye(this.pl.p);
    const d = dist(e, origin);
    if (d < SENSE.visionRange && inView(e, this.pl.yaw, this.pl.pitch, origin) && los(e, origin)) {
      this.remember(shooter.id, jitter(shooter.p, 0.6), 'saw shot');
    } else if (d < SENSE.hearingRange) {
      this.remember(shooter.id, jitter(shooter.p, 1 + d * 0.15), 'heard shot');
    }
  }

  onHurt(attacker, velocity) {
    if (!attacker) return;
    const l = Math.hypot(velocity[0], velocity[2]) || 1;
    const est = hdist(this.pl.p, attacker.p) * rand(0.7, 1.3);
    const pos = [this.pl.p[0] - (velocity[0] / l) * est, attacker.p[1], this.pl.p[2] - (velocity[2] / l) * est];
    this.hurt = { pos, time: this.now() };
    const m = this.memory.get(attacker.id);
    if (!m || !m.visible) this.remember(attacker.id, pos, 'got hit');
  }

  // ------------------------------------------------ Perception & memory

  remember(id, pos, source) {
    let m = this.memory.get(id);
    if (!m) {
      m = { id, pos, vel: [0, 0, 0], time: 0, visible: false, lastVisible: 0, reacted: false, investigated: false, source };
      this.memory.set(id, m);
    }
    m.pos = pos.slice();
    m.time = this.now();
    m.source = source;
    m.investigated = false;
    return m;
  }

  perceive() {
    const t0 = prof.begin();
    this.perceiveInner();
    prof.end('bot.perceive', t0);
  }

  perceiveInner() {
    const now = this.now(), me = this.pl, e = eye(me.p);
    for (const q of this.game.players.values()) {
      if (q === me || !q.alive) continue;
      const target = chest(q.p);
      const d = dist(e, target);
      const m = this.memory.get(q.id);
      const tracking = m && m.visible && now - m.lastVisible < SENSE.trackGraceMs;

      let seen = false;
      if (d < SENSE.visionRange && (d < 2.5 || inView(e, me.yaw, me.pitch, target)) && los(e, target)) {
        // White on white is nearly invisible; paint, muzzle flashes and proximity give players away.
        let vis = 0.04 + 0.22 * q.paintHits + (now - q.lastShot < 500 ? 0.5 : 0) + (d < 4 ? 0.45 : 0);
        vis *= 1 - (0.6 * d) / SENSE.visionRange;
        if (tracking) vis = vis * 2.5 + 0.35;
        seen = Math.random() < vis;
      }

      if (seen) {
        const wasVisible = m && m.visible;
        const prev = wasVisible ? m.pos : null, prevT = wasVisible ? m.lastVisible : 0;
        const mm = this.remember(q.id, q.p, 'seen');
        if (prev && now > prevT) {
          const dt = (now - prevT) / 1000;
          for (let k = 0; k < 3; k++) mm.vel[k] = mm.vel[k] * 0.5 + ((q.p[k] - prev[k]) / dt) * 0.5;
        } else {
          mm.vel = [0, 0, 0];
          mm.reacted = false;
        }
        mm.visible = true;
        mm.lastVisible = now;
      } else if (m && m.visible && now - m.lastVisible > SENSE.trackGraceMs) {
        m.visible = false;
      }
    }
    for (const [id, m] of this.memory) {
      if (!m.visible && now - m.time > SENSE.memoryMs) this.memory.delete(id);
    }
  }

  // ------------------------------------------------ World state for the planner

  worldState() {
    const t0 = prof.begin();
    const ws = this.worldStateInner();
    prof.end('bot.worldState', t0);
    return ws;
  }

  worldStateInner() {
    const now = this.now(), me = this.pl;
    let enemy = null, enemyDist = Infinity, enemyFresh = false, enemyPos = null, threat = null;
    for (const [id, m] of this.memory) {
      const q = this.game.players.get(id);
      if (!q || !q.alive) { this.memory.delete(id); continue; }
      if (m.visible) {
        const d = dist(me.p, q.p);
        if (d < enemyDist) { enemy = id; enemyDist = d; enemyFresh = !m.reacted; enemyPos = q.p.slice(); }
      } else if (!m.investigated) {
        const d = dist(me.p, m.pos);
        if (!threat || d < threat.dist) threat = { id, pos: m.pos.slice(), dist: d };
      }
    }
    const hurtFrom = !enemy && this.hurt && now - this.hurt.time < 2500 ? this.hurt.pos : null;
    const dangerPos = enemyPos || threat?.pos || hurtFrom;
    const retreatReady = now - this.lastRetreat > 10000;
    const cover = me.hp <= 40 && dangerPos && retreatReady ? this.findCover(dangerPos) : null;
    return {
      hp: me.hp, enemy, enemyDist, enemyFresh, threat, hurtFrom, dangerPos, cover, retreatReady,
      roll: Math.random(),
      revealPoint: this.pickRevealPoint(),
      wanderPoint: this.pickWanderPoint(),
    };
  }

  findCover(danger) {
    const t0 = prof.begin();
    const c = this.findCoverInner(danger);
    prof.end('bot.findCover', t0);
    return c;
  }

  findCoverInner(danger) {
    const me = this.pl, de = eye(danger);
    let best = null, bestD = Infinity;
    for (const n of this.nav.okNodes) {
      const d = hdist(n.p, me.p);
      if (d < 3 || d > 16 || d >= bestD || hdist(n.p, danger) < 8) continue;
      if (los(de, eye(n.p))) continue;
      best = n;
      bestD = d;
    }
    return best ? best.p : null;
  }

  pickRevealPoint() {
    const e = eye(this.pl.p);
    for (let k = 0; k < 8; k++) {
      const n = this.nav.randomNode();
      const d = hdist(n.p, this.pl.p);
      if (d > 6 && d < 30 && los(e, [n.p[0], n.p[1] + 0.5, n.p[2]])) return n.p;
    }
    return null;
  }

  pickWanderPoint() {
    for (let k = 0; k < 8; k++) {
      const n = this.nav.randomNode();
      if (hdist(n.p, this.pl.p) > 8) return n.p;
    }
    return this.nav.randomNode().p;
  }

  // ------------------------------------------------ Planning

  think() {
    if (!this.plan) return;
    const t0 = prof.begin();
    const ws = this.worldState();
    const best = ROOT.findIndex(m => m.cond(ws));
    if (best < this.rootIndex) this.replan(ws, 'interrupt');
    prof.end('bot.think', t0);
  }

  replan(ws, reason = 'finished') {
    const t0 = prof.begin();
    prof.count(`bot.replan.${reason}`);
    const res = plan(D, ws, [t('Live')]);
    prof.end('bot.plan', t0);
    this.gen = null;
    this.step = 0;
    if (!res) {
      this.plan = { steps: [t('Wait', { time: 0.5 })], trace: ['Live:idle'] };
      this.rootIndex = ROOT.length;
      return;
    }
    this.plan = res;
    this.rootIndex = ROOT.findIndex(m => `Live:${m.name}` === res.trace[0]);
    if (DEBUG) console.log(`[${this.pl.name}] ${res.trace.join(' > ')} => ${res.steps.map(s => s.name).join(', ')}`);
  }

  // ------------------------------------------------ Tick

  update(dt) {
    if (!this.pl.alive) return;
    this.senseTimer -= dt;
    if (this.senseTimer <= 0) {
      this.senseTimer = SENSE.interval;
      this.perceive();
      this.think();
    }
    if (!this.plan) this.replan(this.worldState(), this.lastFailed ? 'failed' : 'finished');
    this.lastFailed = false;
    let t0 = prof.begin();
    this.runBehavior();
    prof.end('bot.behaviors', t0);
    t0 = prof.begin();
    this.steer(dt);
    prof.end('bot.move', t0);
  }

  runBehavior() {
    this.moveDir = null;
    for (let guard = 0; guard < 4; guard++) {
      if (!this.plan) return;
      if (!this.gen) {
        const step = this.plan.steps[this.step];
        if (!step) { this.plan = null; return; }
        this.gen = BEHAVIORS[step.name].call(this, step.args);
      }
      const r = this.gen.next();
      if (!r.done) return;
      this.gen = null;
      if (r.value === false) {
        prof.count(`bot.failed.${this.plan.steps[this.step].name}`);
        this.lastFailed = true;
        this.plan = null;
        return;
      }
      this.step++;
    }
  }

  steer(dt) {
    const me = this.pl;
    const rate = (2.8 + 3 * this.skill) * dt;
    const k = Math.min(1, 9 * dt);
    const clamp = x => Math.max(-rate, Math.min(rate, x));
    me.yaw += clamp(angDiff(this.wantYaw, me.yaw) * k);
    me.pitch += clamp((this.wantPitch - me.pitch) * k);

    let f = 0, r = 0;
    if (this.moveDir) {
      const [dx, dz] = this.moveDir, s = Math.sin(me.yaw), c = Math.cos(me.yaw);
      f = -dx * s - dz * c;
      r = dx * c - dz * s;
    }
    const speed = Math.hypot(me.v[0], me.v[2]);
    this.stuckTime = this.moveDir && speed < 1 ? this.stuckTime + dt : 0;
    movePlayer(me, { f, r, jump: this.stuckTime > 0.4, yaw: me.yaw }, dt);
  }

  // ------------------------------------------------ Movement & aim helpers

  route(pos) {
    const path = this.nav.findPath(this.pl.p, pos);
    if (!path) return null;
    let i = 0;
    if (path.length > 1 && hdist(this.pl.p, path[1]) < hdist(path[0], path[1])) i = 1;
    return { path, i };
  }

  // Steers along a route; returns false when the end is reached.
  follow(route) {
    const { path } = route;
    while (route.i < path.length - 1 && hdist(this.pl.p, path[route.i]) < 0.8) route.i++;
    const tgt = path[route.i];
    const dx = tgt[0] - this.pl.p[0], dz = tgt[2] - this.pl.p[2], l = Math.hypot(dx, dz);
    if (route.i === path.length - 1 && l < 0.6) return false;
    this.moveDir = [dx / (l || 1), dz / (l || 1)];
    return true;
  }

  lookAt(point) {
    const e = eye(this.pl.p);
    const dx = point[0] - e[0], dy = point[1] - e[1], dz = point[2] - e[2];
    this.wantYaw = Math.atan2(-dx, -dz);
    this.wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  lookAlong() {
    if (!this.moveDir) return;
    this.wantYaw = Math.atan2(-this.moveDir[0], -this.moveDir[1]);
    this.wantPitch = -0.05;
  }

  aimBallistic(point, rangeFactor = 1) {
    const e = eye(this.pl.p);
    const dx = point[0] - e[0], dy = point[1] - e[1], dz = point[2] - e[2];
    this.wantYaw = Math.atan2(-dx, -dz);
    this.wantPitch = ballisticPitch(Math.hypot(dx, dz) * rangeFactor, dy);
  }

  // Aims at a remembered enemy with partial lead and a misjudged range.
  aimAtTarget(q, m) {
    const base = m.visible ? q.p : m.pos;
    const flight = hdist(eye(this.pl.p), base) / C.BLOB_SPEED;
    const lead = this.skill * 0.7;
    this.aimBallistic([
      base[0] + m.vel[0] * flight * lead,
      base[1] + 1.15,
      base[2] + m.vel[2] * flight * lead,
    ], this.rangeErr);
  }

  aimError() {
    return Math.hypot(angDiff(this.wantYaw, this.pl.yaw), this.wantPitch - this.pl.pitch);
  }

  tryFire() {
    const now = this.now(), me = this.pl;
    if (now < this.nextShot || !this.game.isPlaying() || this.aimError() > 0.12) return false;
    const sigma = (0.075 - 0.045 * this.skill) * (this.moveDir ? 1.35 : 1);
    const d = dirOf(me.yaw + gauss() * sigma, me.pitch + gauss() * sigma);
    const e = eye(me.p);
    const o = e.map((x, i) => x + d[i] * C.MUZZLE_OFFSET);
    if (!this.game.fire(me, o, d)) return false;
    this.nextShot = now + C.FIRE_INTERVAL * 1000 * rand(1.15, 1.8);
    return true;
  }
}

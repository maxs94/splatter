// Shared between server (Node) and client (browser): config, level, physics.

export const CONFIG = {
  TICK_RATE: 60,
  STATE_RATE: 20,

  PLAYER_RADIUS: 0.4,
  PLAYER_HEIGHT: 1.8,
  EYE_HEIGHT: 1.6,
  CROUCH_HEIGHT: 1.4,
  CROUCH_EYE_HEIGHT: 1.2,
  MOVE_SPEED: 7,
  CROUCH_SPEED: 2.8,
  JUMP_SPEED: 7.5,
  GRAVITY: 20,
  STEP_HEIGHT: 0.45,

  BLOB_RADIUS: 0.12,
  MUZZLE_OFFSET: 0.2,
  RELOAD_SLACK: 0.1, // seconds the server lets a reload finish early, for latency

  MAX_HP: 100,
  RESPAWN_TIME: 3,
  REGEN_DELAY: 4,   // seconds without damage before health regenerates
  REGEN_RATE: 12,   // health per second

  COUNTDOWN: 5,
  LOADING_TIMEOUT: 12,

  ROUND_TIME: 300,
  INTERMISSION: 10,

  SPLAT_RADIUS: 0.75,
  MAX_SPLATS: 5000,
};

// Guns, indexed by the id sent over the wire. You pick one, it is yours for your next life,
// bought when you spawn (price) if you have the money, otherwise you get the free pistol.
// interval: seconds between shots, auto: keeps firing while the button is held,
// lifetime: seconds a shot flies before it dries up in the air (that is the range),
// splat: size of the paint splat relative to SPLAT_RADIUS.
export const WEAPONS = [
  { name: 'Color gun', price: 400, ammo: 30, auto: true, interval: 0.18, speed: 42, gravity: 9, lifetime: 4, damage: 25, reload: 1.6, splat: 1,
    info: 'Lobs paint in an arc' },
  { name: 'Pistol', price: 0, ammo: 10, auto: false, interval: 0.22, speed: 38, gravity: 9, lifetime: 0.45, damage: 25, reload: 1.1, splat: 0.8,
    info: 'Short range, one shot per click' },
  { name: 'Rifle', price: 900, ammo: 30, auto: true, interval: 0.1, speed: 60, gravity: 5, lifetime: 0.8, damage: 20, reload: 1.8, splat: 0.7,
    info: 'Fast fire, middle range' },
  { name: 'Sniper', price: 1400, ammo: 3, auto: false, interval: 1, speed: 170, gravity: 0, lifetime: 0.6, damage: 100, reload: 2.5, splat: 1.2,
    info: 'Straight and far, one hit splats' },
];

// The free gun: what you get when you can't pay for the one you picked.
export const DEFAULT_WEAPON = 1;

// Money: everybody starts a match with start, a kill pays killBase plus perStreakKill for
// every kill the victim made since their last death. Guns and grenades are bought each life.
export const ECONOMY = { start: 0, grenade: 300, maxGrenades: 3, killBase: 300, perStreakKill: 150, max: 16000 };
export const bounty = streak => ECONOMY.killBase + ECONOMY.perStreakKill * streak;

// Color grenades, bought with money (see ECONOMY). One bounces, then bursts and paints everything around it.
export const GRENADE = {
  speed: 22.6, gravity: 20, fuse: 1.6, bounce: 0.45,
  radius: 13.5, damage: 100, minDamage: 20, // damage at the center, falling to minDamage at the edge
  rays: 48, splat: 6.4,
};

// Where a shot lands on a player. The head is a small sphere the shot itself has to pass
// through: an instant kill. legs: hits below this fraction of the height, arm: hits above
// that more than this many meters to the side of the body. Arms and legs take limbDamage
// of the gun's damage.
export const HIT_ZONES = { headRadius: 0.13, legs: 0.45, arm: 0.22, limbDamage: 0.6 };

// Where the character model's head is, measured on the standing model: its spine and neck
// joints and the center of the head as [right, up, forward] from the feet. Aiming bends
// the spine by half the pitch and the neck by 0.4 of it (see poseCharacter).
const HEAD_RIG = { spine: [0.008, 1.206, 0.021], neck: [0.027, 1.428, 0.056], head: [0.054, 1.623, 0.069] };

export const PALETTE = [
  '#ff3b30', // red
  '#ff9500', // orange
  '#ffcc00', // yellow
  '#7ed321', // lime
  '#00b894', // green
  '#00c7e6', // cyan
  '#0a6cff', // blue
  '#6a4cff', // indigo
  '#d63bff', // purple
  '#ff2d92', // pink
  // second row: deeper and muted tones, roughly under their bright neighbours
  '#b3122e', // crimson
  '#8a5a2b', // brown
  '#c9a100', // gold
  '#6f8a12', // olive
  '#00766f', // dark teal
  '#5fb8ff', // sky blue
  '#1d2c86', // navy
  '#7c7f87', // gray
  '#1c1c1e', // ink
  '#ff7f6e', // coral
];

// ---------------------------------------------------------------- Level

const boxes = [];
function box(x0, y0, z0, x1, y1, z1, opts = {}) {
  boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], ...opts });
}
function block(cx, cz, w, d, h, y0 = 0) {
  box(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2);
}
// Stairs start at (x, z) and rise along (dx, dz); step i is (i + 1) * stepH tall.
function stairs(x, z, dx, dz, width, count, stepH, stepD) {
  for (let i = 0; i < count; i++) {
    const a = i * stepD, b = (i + 1) * stepD, h = (i + 1) * stepH;
    if (dx) {
      const xa = x + dx * a, xb = x + dx * b;
      box(Math.min(xa, xb), 0, z - width / 2, Math.max(xa, xb), h, z + width / 2);
    } else {
      const za = z + dz * a, zb = z + dz * b;
      box(x - width / 2, 0, Math.min(za, zb), x + width / 2, h, Math.max(za, zb));
    }
  }
}

const HALF = 32;

// Floor, split into tiles so paint texture uploads stay small.
for (let i = -HALF; i < HALF; i += 8) {
  for (let j = -HALF; j < HALF; j += 8) box(i, -1, j, i + 8, 0, j + 8, { floor: true });
}

// Outer walls
box(-HALF - 1, 0, -HALF - 1, HALF + 1, 8, -HALF);
box(-HALF - 1, 0, HALF, HALF + 1, 8, HALF + 1);
box(-HALF - 1, 0, -HALF, -HALF, 8, HALF);
box(HALF, 0, -HALF, HALF + 1, 8, HALF);

// Central platform with two staircases
block(0, 0, 10, 10, 2.4);
stairs(0, 8.6, 0, -1, 3, 6, 0.4, 0.6);
stairs(0, -8.6, 0, 1, 3, 6, 0.4, 0.6);

// Long cover walls
block(0, -20, 14, 1, 3.5);
block(0, 20, 14, 1, 3.5);
block(-20, 0, 1, 14, 3.5);
block(20, 0, 1, 14, 3.5);

// Pillars
for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(sx * 12, sz * 12, 2, 2, 6);

// Corner platforms with stairs facing the center line
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    block(sx * 25, sz * 25, 10, 10, 2);
    stairs(sx * 17, sz * 25, sx, 0, 3, 5, 0.4, 0.6);
  }
}

// Crates
block(-6, -13, 2, 2, 1);
block(6, 13, 2, 2, 1);
block(-13, 6, 2, 2, 1);
block(13, -6, 2, 2, 1);
block(-26, 8, 3, 2, 1.2);
block(26, -8, 3, 2, 1.2);
block(8, -27, 2, 3, 1.2);
block(-8, 27, 2, 3, 1.2);

// Short walls
block(-14, -24, 1, 6, 2.5);
block(14, 24, 1, 6, 2.5);
block(-24, 14, 6, 1, 2.5);
block(24, -14, 6, 1, 2.5);

export const LEVEL = {
  half: HALF,
  boxes,
  spawns: [
    [16, 0, 0], [-16, 0, 0], [0, 0, 15], [0, 0, -15],
    [27, 0, 0], [-27, 0, 0], [0, 0, 27], [0, 0, -27],
    [25, 2, 25], [-25, 2, 25], [25, 2, -25], [-25, 2, -25],
    [0, 2.4, 0],
  ],
};

// ---------------------------------------------------------------- Helpers

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Segment o -> o + s against an AABB grown by pad.
// Returns { t in [0,1], axis, sign } of the entry face, or null.
export function segBox(o, s, min, max, pad) {
  let tmin = 0, tmax = 1, axis = -1, sign = 0;
  for (let a = 0; a < 3; a++) {
    const lo = min[a] - pad, hi = max[a] + pad;
    if (Math.abs(s[a]) < 1e-9) {
      if (o[a] < lo || o[a] > hi) return null;
      continue;
    }
    let t1 = (lo - o[a]) / s[a], t2 = (hi - o[a]) / s[a], sg = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null;
  return { t: tmin, axis, sign };
}

// First level hit along the segment o -> o + s, or null.
export function segLevel(o, s, pad) {
  let hit = null;
  for (const b of boxes) {
    const h = segBox(o, s, b.min, b.max, pad);
    if (h && (!hit || h.t < hit.t)) { hit = h; hit.box = b; }
  }
  return hit;
}

// Advances a projectile { p, v, w } (w: index into WEAPONS, or nade: true) by dt and
// reports the first level hit along the way. Grenades bounce off the level instead.
export function stepProjectile(pr, dt) {
  pr.v[1] -= (pr.nade ? GRENADE.gravity : WEAPONS[pr.w].gravity) * dt;
  const o = pr.p;
  const s = [pr.v[0] * dt, pr.v[1] * dt, pr.v[2] * dt];
  const hit = segLevel(o, s, CONFIG.BLOB_RADIUS);
  if (pr.nade && hit) {
    // Stop at the wall, mirror the velocity off it and lose some speed.
    const a = hit.axis, face = hit.sign > 0 ? hit.box.max[a] : hit.box.min[a];
    pr.p = [o[0] + s[0] * hit.t, o[1] + s[1] * hit.t, o[2] + s[2] * hit.t];
    pr.p[a] = face + hit.sign * (CONFIG.BLOB_RADIUS + 2e-3);
    pr.v[hit.axis] = -pr.v[hit.axis];
    for (let a = 0; a < 3; a++) pr.v[a] *= GRENADE.bounce;
    return { o, s, hit: null };
  }
  pr.p = [o[0] + s[0], o[1] + s[1], o[2] + s[2]];
  return { o, s, hit };
}

// Point where a hit touches the actual (unpadded) surface.
export function hitPoint(o, s, hit) {
  const q = [o[0] + s[0] * hit.t, o[1] + s[1] * hit.t, o[2] + s[2] * hit.t];
  if (hit.box) q[hit.axis] = hit.sign > 0 ? hit.box.max[hit.axis] : hit.box.min[hit.axis];
  return q;
}

// True when nothing in the level blocks the straight line from a to b.
export function lineOfSight(a, b) {
  const s = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (const box of boxes) {
    if (segBox(a, s, box.min, box.max, 0)) return false;
  }
  return true;
}

// Which way to look after spawning at p: the direction with the most open view at eye
// height, leaning towards the arena center when several are about equally open.
// Deterministic, so server, bots and clients agree without sending it.
export function spawnYaw(p) {
  const e = [p[0], p[1] + CONFIG.EYE_HEIGHT, p[2]];
  const center = Math.atan2(p[0], p[2]);
  const MAX_VIEW = 40, OPEN = 30, N = 32;
  let best = center, bestScore = -Infinity;
  for (let i = 0; i < N; i++) {
    const yaw = center + (i / N) * Math.PI * 2;
    const s = [-Math.sin(yaw) * MAX_VIEW, 0, -Math.cos(yaw) * MAX_VIEW];
    let t = 1;
    for (const b of boxes) {
      const h = segBox(e, s, b.min, b.max, 0);
      if (h && h.t < t) t = h.t;
    }
    const score = Math.min(t * MAX_VIEW, OPEN) + 4 * Math.cos(yaw - center);
    if (score > bestScore) { bestScore = score; best = yaw; }
  }
  return Math.atan2(Math.sin(best), Math.cos(best));
}

// Highest walkable surface under (x, z) at or below fromY.
export function groundHeight(x, z, fromY) {
  let y = 0;
  for (const b of boxes) {
    if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] &&
        b.max[1] <= fromY + 0.01 && b.max[1] > y) y = b.max[1];
  }
  return y;
}

// ---------------------------------------------------------------- Player movement

export const playerHeight = s => (s.crouch ? CONFIG.CROUCH_HEIGHT : CONFIG.PLAYER_HEIGHT);
export const eyeHeight = s => (s.crouch ? CONFIG.CROUCH_EYE_HEIGHT : CONFIG.EYE_HEIGHT);

// Center of player s's head in the world, following the model's pose.
export function headCenter(s) {
  const { spine, neck, head } = HEAD_RIG;
  // Bending towards the back when looking up: (forward, up) turned by angle a.
  const turn = (f, u, a) => [f * Math.cos(a) - u * Math.sin(a), f * Math.sin(a) + u * Math.cos(a)];
  const pitch = s.pitch || 0;
  const [f1, u1] = turn(neck[2] - spine[2], neck[1] - spine[1], pitch * 0.5);
  const [f2, u2] = turn(head[2] - neck[2], head[1] - neck[1], pitch * 0.9);
  const fwd = spine[2] + f1 + f2, up = spine[1] + u1 + u2 + playerHeight(s) - CONFIG.PLAYER_HEIGHT;
  const right = head[0], yaw = s.yaw || 0;
  return [
    s.p[0] + right * Math.cos(yaw) - fwd * Math.sin(yaw),
    s.p[1] + up,
    s.p[2] - right * Math.sin(yaw) - fwd * Math.cos(yaw),
  ];
}

// Which part of player s the shot o -> o + s hit: 'head', 'body', 'arm' or 'leg'.
// off: where it entered the hitbox, relative to the feet. Facing yaw, the player's right
// is (cos yaw, 0, -sin yaw).
export function hitZone(o, seg, off, s) {
  const h = playerHeight(s);
  const head = headCenter(s);
  // Closest point of the shot's path to the center of the head. The path goes on past
  // this step's segment: it entered the hitbox and would fly on through it.
  const len2 = seg[0] ** 2 + seg[1] ** 2 + seg[2] ** 2 || 1;
  const t = Math.max(0, ((head[0] - o[0]) * seg[0] + (head[1] - o[1]) * seg[1] + (head[2] - o[2]) * seg[2]) / len2);
  const d2 = [0, 1, 2].reduce((sum, k) => sum + (o[k] + seg[k] * t - head[k]) ** 2, 0);
  if (d2 < HIT_ZONES.headRadius ** 2) return 'head';
  if (off[1] < h * HIT_ZONES.legs) return 'leg';
  const side = off[0] * Math.cos(s.yaw || 0) - off[2] * Math.sin(s.yaw || 0);
  return Math.abs(side) > HIT_ZONES.arm ? 'arm' : 'body';
}

function overlapping(p, h) {
  const r = CONFIG.PLAYER_RADIUS;
  const out = [];
  for (const b of boxes) {
    if (p[0] + r > b.min[0] && p[0] - r < b.max[0] &&
        p[1] + h > b.min[1] && p[1] < b.max[1] &&
        p[2] + r > b.min[2] && p[2] - r < b.max[2]) out.push(b);
  }
  return out;
}

// s: { p:[x,y,z] (feet), v:[vx,vy,vz], onGround, crouch }, inp: { f, r, jump, crouch, yaw }
export function movePlayer(s, inp, dt) {
  // Crouching lasts while held, and after letting go until there is room to stand up.
  if (inp.crouch) s.crouch = true;
  else if (s.crouch && !overlapping(s.p, CONFIG.PLAYER_HEIGHT).length) s.crouch = false;
  const h = playerHeight(s);
  const speed = s.crouch ? CONFIG.CROUCH_SPEED : CONFIG.MOVE_SPEED;

  const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
  let wx = -sin * inp.f + cos * inp.r;
  let wz = -cos * inp.f - sin * inp.r;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx /= len; wz /= len; }
  const k = Math.min(1, (s.onGround ? 14 : 3) * dt);
  s.v[0] += (wx * speed - s.v[0]) * k;
  s.v[2] += (wz * speed - s.v[2]) * k;
  if (inp.jump && s.onGround && !s.crouch) { s.v[1] = CONFIG.JUMP_SPEED; s.onGround = false; }

  for (const ax of [0, 2]) {
    const step = s.v[ax] * dt;
    if (!step) continue;
    const np = s.p.slice();
    np[ax] += step;
    const hits = overlapping(np, h);
    if (!hits.length) { s.p = np; continue; }
    const top = Math.max(...hits.map(b => b.max[1]));
    if (s.onGround && top - s.p[1] <= CONFIG.STEP_HEIGHT) {
      np[1] = top;
      if (!overlapping(np, h).length) { s.p = np; continue; }
    }
    s.v[ax] = 0;
  }

  s.v[1] -= CONFIG.GRAVITY * dt;
  const np = s.p.slice();
  np[1] += s.v[1] * dt;
  const hits = overlapping(np, h);
  if (!hits.length) {
    s.p = np;
    s.onGround = false;
  } else if (s.v[1] <= 0) {
    s.p[1] = Math.max(...hits.map(b => b.max[1]));
    s.v[1] = 0;
    s.onGround = true;
  } else {
    s.p[1] = Math.min(...hits.map(b => b.min[1])) - h - 1e-4;
    s.v[1] = 0;
  }
}

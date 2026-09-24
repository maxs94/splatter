// Ragdoll for splatted players: a Verlet particle skeleton (points at the joints,
// rigid sticks between them, cross braces for the torso) that falls under gravity,
// collides with the level boxes and gets pushed where the fatal shot hit. Every frame
// the bones of the skinned model are turned to follow the particles.

import * as THREE from 'three';
import { LEVEL } from '/shared/game.js';

const PELVIS = 0, CHEST = 1, NECK = 2, HEAD = 3;
const LSH = 4, LEL = 5, LHA = 6, RSH = 7, REL = 8, RHA = 9;
const LHI = 10, LKN = 11, LAN = 12, LTO = 13, RHI = 14, RKN = 15, RAN = 16, RTO = 17;
const COUNT = 18;
const RADIUS = [0.12, 0.13, 0.08, 0.11, 0.07, 0.06, 0.06, 0.07, 0.06, 0.06, 0.08, 0.07, 0.06, 0.05, 0.08, 0.07, 0.06, 0.05];
const MASS = [3, 3, 1.5, 1.5, 1, 0.8, 0.5, 1, 0.8, 0.5, 1.5, 1, 0.6, 0.3, 1.5, 1, 0.6, 0.3];

// Particle positions from the posed skeleton (bone local Y points along the bone).
const PARTICLES = [
  ['LowerBack', 0], ['Spine', 0], ['Neck1', 0], ['Head', 0.2],
  ['LeftArm', 0], ['LeftForeArm', 0], ['LeftForeArm', 0.27],
  ['RightArm', 0], ['RightForeArm', 0], ['RightForeArm', 0.27],
  ['LeftUpLeg', 0], ['LeftLeg', 0], ['LeftFoot', 0], ['LeftFoot', 0.16],
  ['RightUpLeg', 0], ['RightLeg', 0], ['RightFoot', 0], ['RightFoot', 0.16],
];

// Rigid sticks: the bones plus braces that keep the torso and feet in shape.
const STICKS = [
  [PELVIS, CHEST], [CHEST, NECK], [NECK, HEAD],
  [LSH, LEL], [LEL, LHA], [RSH, REL], [REL, RHA],
  [LHI, LKN], [LKN, LAN], [LAN, LTO], [RHI, RKN], [RKN, RAN], [RAN, RTO],
  [PELVIS, LHI], [PELVIS, RHI], [LHI, RHI],
  [CHEST, LSH], [CHEST, RSH], [NECK, LSH], [NECK, RSH], [LSH, RSH],
  [LSH, LHI], [RSH, RHI], [LSH, RHI], [RSH, LHI], [PELVIS, NECK],
  [CHEST, HEAD], [LKN, LTO], [RKN, RTO],
];
// "Muscles": braces that keep legs, arms and head stiff right after the hit, so the
// whole body topples from the push instead of buckling on the spot. They fade out.
const STIFF = [[LHI, LAN], [RHI, RAN], [PELVIS, LAN], [PELVIS, RAN], [LSH, LHA], [RSH, RHA], [PELVIS, HEAD], [LHI, LTO], [RHI, RTO]];
const STIFF_TIME = 0.55;
// Soft limits so knees and elbows can't fold completely: minimum distances.
const MIN_DIST = [[LHI, LAN, 0.55], [RHI, RAN, 0.55], [LSH, LHA, 0.45], [RSH, RHA, 0.45], [PELVIS, HEAD, 0.8]];

// Bones in parent-first order, with the particles that steer them.
// Limbs follow a direction; torso and head follow a direction plus a side axis.
const BONES = [
  ['LowerBack', PELVIS, CHEST, LHI, RHI],
  ['Spine', CHEST, NECK, LSH, RSH],
  ['Neck1', NECK, HEAD, LSH, RSH],
  ['Head', NECK, HEAD, LSH, RSH],
  ['LeftArm', LSH, LEL], ['LeftForeArm', LEL, LHA],
  ['RightArm', RSH, REL], ['RightForeArm', REL, RHA],
  ['LeftUpLeg', LHI, LKN], ['LeftLeg', LKN, LAN], ['LeftFoot', LAN, LTO],
  ['RightUpLeg', RHI, RKN], ['RightLeg', RKN, RAN], ['RightFoot', RAN, RTO],
];
const ROOTS = { LowerBack: PELVIS, LeftUpLeg: LHI, RightUpLeg: RHI };

const GRAVITY = -9.8;
const STEP = 1 / 60;
const ITERATIONS = 10;
const SLEEP_AFTER = 5;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

function frameQuat(dir, side, out) {
  // orthonormal frame: y along dir, x along side (made perpendicular)
  const y = _v.copy(dir).normalize();
  const x = _w.copy(side).addScaledVector(y, -side.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

// colliders: boxes ({ min, max }) the body lands on, the level by default.
export function createRagdoll(ch, colliders = LEVEL.boxes) {
  const bones = ch.bones;
  const p = Array.from({ length: COUNT }, () => new THREE.Vector3());
  const prev = Array.from({ length: COUNT }, () => new THREE.Vector3());
  let rest = [], minDist = [], stiffRest = [];
  let setup = [];
  let active = false, time = 0, acc = 0;

  // Starts the ragdoll from the current pose. velocity: body velocity (THREE.Vector3).
  function start(velocity) {
    ch.root.updateMatrixWorld(true);
    PARTICLES.forEach(([name, along], i) => {
      bones[name].localToWorld(p[i].set(0, along, 0));
      prev[i].copy(p[i]).addScaledVector(velocity, -STEP);
    });
    rest = STICKS.map(([a, b]) => p[a].distanceTo(p[b]));
    minDist = MIN_DIST.map(([a, b, k]) => [a, b, p[a].distanceTo(p[b]) * k]);
    stiffRest = STIFF.map(([a, b]) => p[a].distanceTo(p[b]));
    // How each bone's world rotation relates to its particles at the start.
    setup = BONES.map(([name, a, b, s1, s2]) => {
      const q0 = bones[name].getWorldQuaternion(new THREE.Quaternion());
      const dir0 = p[b].clone().sub(p[a]);
      if (s1 === undefined) return { name, a, b, q0, dir0: dir0.normalize() };
      const f0 = frameQuat(dir0, p[s1].clone().sub(p[s2]), new THREE.Quaternion());
      return { name, a, b, s1, s2, q0, f0inv: f0.invert() };
    });
    active = true;
    time = 0;
    acc = 0;
  }

  // Pushes the body: strongest at the hit point, a little everywhere.
  function hit(point, dir, strength = 6) {
    const d = _v.copy(dir).normalize();
    for (let i = 0; i < COUNT; i++) {
      const dist2 = p[i].distanceToSquared(point);
      const k = strength * Math.exp(-dist2 / 0.08) + strength * 0.45;
      prev[i].addScaledVector(d, -k * STEP / Math.sqrt(MASS[i]));
    }
  }

  function collide(i) {
    const r = RADIUS[i], q = p[i];
    for (const b of colliders) {
      if (q.x < b.min[0] - r || q.x > b.max[0] + r || q.y < b.min[1] - r || q.y > b.max[1] + r ||
          q.z < b.min[2] - r || q.z > b.max[2] + r) continue;
      // push out along the axis of least penetration
      const pen = [
        q.x - (b.min[0] - r), (b.max[0] + r) - q.x,
        q.y - (b.min[1] - r), (b.max[1] + r) - q.y,
        q.z - (b.min[2] - r), (b.max[2] + r) - q.z,
      ];
      let k = 0;
      for (let j = 1; j < 6; j++) if (pen[j] < pen[k]) k = j;
      const axis = k >> 1, sign = k & 1 ? 1 : -1;
      q.setComponent(axis, q.getComponent(axis) + sign * pen[k]);
      // friction: slow down sliding along the surface
      for (let a = 0; a < 3; a++) {
        if (a === axis) continue;
        const pv = prev[i].getComponent(a);
        prev[i].setComponent(a, q.getComponent(a) - (q.getComponent(a) - pv) * 0.6);
      }
    }
  }

  function simulate() {
    for (let i = 0; i < COUNT; i++) {
      _v.subVectors(p[i], prev[i]).multiplyScalar(0.992);
      prev[i].copy(p[i]);
      p[i].add(_v);
      p[i].y += GRAVITY * STEP * STEP;
    }
    const stiffness = Math.max(0, 1 - time / STIFF_TIME);
    for (let it = 0; it < ITERATIONS; it++) {
      STICKS.forEach(([a, b], s) => satisfy(a, b, rest[s], false));
      if (stiffness > 0) STIFF.forEach(([a, b], s) => satisfy(a, b, stiffRest[s], false, stiffness * 0.5));
      for (const [a, b, d] of minDist) satisfy(a, b, d, true);
      for (let i = 0; i < COUNT; i++) collide(i);
    }
  }

  function satisfy(a, b, len, onlyMin, strength = 1) {
    _v.subVectors(p[b], p[a]);
    const d = _v.length() || 1e-6;
    if (onlyMin && d >= len) return;
    const wa = 1 / MASS[a], wb = 1 / MASS[b];
    const diff = strength * (d - len) / (d * (wa + wb));
    p[a].addScaledVector(_v, diff * wa);
    p[b].addScaledVector(_v, -diff * wb);
  }

  function step(dt) {
    if (!active || time > SLEEP_AFTER) return;
    acc = Math.min(acc + dt, 0.1);
    while (acc >= STEP) { simulate(); acc -= STEP; time += STEP; }
  }

  // Turns the bones to follow the particles.
  function apply() {
    if (!active) return;
    for (const s of setup) {
      const bone = bones[s.name];
      const dir = _w.subVectors(p[s.b], p[s.a]);
      let qw;
      if (s.s1 === undefined) {
        qw = _q.setFromUnitVectors(s.dir0, dir.normalize()).multiply(s.q0);
      } else {
        const f = frameQuat(dir, new THREE.Vector3().subVectors(p[s.s1], p[s.s2]), new THREE.Quaternion());
        qw = f.multiply(s.f0inv).multiply(s.q0);
      }
      const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(parentQ.invert().multiply(qw));
      if (ROOTS[s.name] !== undefined) {
        bone.position.copy(bone.parent.worldToLocal(p[ROOTS[s.name]].clone()));
      }
      bone.updateMatrixWorld(true);
    }
  }

  function stop() { active = false; }

  return { start, hit, step, apply, stop, get active() { return active; }, points: p };
}

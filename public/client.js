import * as THREE from 'three';
import { CONFIG as C, PALETTE, LEVEL, movePlayer, stepProjectile, mulberry32, groundHeight } from '/shared/game.js';
import { initAudio, play, tone, updateListener, getVolume, setVolume } from './js/audio.js';
import { assetsReady, createCharacter, cloneGun, locomotion, poseCharacter, setAnim } from './js/characters.js';
import { createLobby } from './js/lobby.js';
import { createViewer } from './js/viewer.js';

const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const PALETTE_RGB = PALETTE.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

// ---------------------------------------------------------------- Renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
// Lights only affect the first-person gun; the world uses unlit materials.
scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8c94, 1.8));
const gunLight = new THREE.DirectionalLight(0xffffff, 1.6);
gunLight.position.set(3, 10, 4);
scene.add(gunLight);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 250);
camera.rotation.order = 'YXZ';
scene.add(camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- Paintable level
// Every visible box face is a quad with its own canvas texture. Unpainted, it is
// exactly as white as the background, so the level is invisible until painted.

const PPM = 24; // texture pixels per meter
// Per-face brightness so painted areas read as 3D: +x, -x, +y, -y, +z, -z
const SHADE = [0.8, 0.7, 1.0, 0.55, 0.9, 0.78];
const faces = [];
const maxAniso = renderer.capabilities.getMaxAnisotropy();

for (const b of LEVEL.boxes) {
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      if (axis === 1 && sign < 0) continue; // bottoms are never seen
      if (b.floor && !(axis === 1 && sign > 0)) continue;
      const ua = axis === 0 ? 2 : 0;
      const va = axis === 1 ? 2 : 1;
      const umin = b.min[ua], umax = b.max[ua], vmin = b.min[va], vmax = b.max[va];
      if (umax - umin < 1e-3 || vmax - vmin < 1e-3) continue;
      const plane = sign > 0 ? b.max[axis] : b.min[axis];

      const canvas = document.createElement('canvas');
      canvas.width = Math.min(2048, Math.max(4, Math.ceil((umax - umin) * PPM)));
      canvas.height = Math.min(2048, Math.max(4, Math.ceil((vmax - vmin) * PPM)));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;

      const pos = [], uv = [];
      for (const [u, v] of [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]]) {
        const p = [0, 0, 0];
        p[axis] = plane; p[ua] = u; p[va] = v;
        pos.push(...p);
        uv.push((u - umin) / (umax - umin), (v - vmin) / (vmax - vmin));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      scene.add(mesh);

      faces.push({
        axis, sign, ua, va, plane, umin, umax, vmin, vmax, canvas, ctx, tex,
        sx: canvas.width / (umax - umin), sy: canvas.height / (vmax - vmin),
        shade: SHADE[axis * 2 + (sign > 0 ? 0 : 1)], dirty: false,
      });
    }
  }
}

function clearPaint() {
  for (const f of faces) {
    f.ctx.fillStyle = '#fff';
    f.ctx.fillRect(0, 0, f.canvas.width, f.canvas.height);
    f.dirty = true;
  }
}

// Splat shape in the hit plane: a lumpy core, flung droplets and a few streaks.
function splatShape(r, seed) {
  const rng = mulberry32(seed);
  const circles = [[0, 0, r * 0.55]];
  const lumps = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < lumps; i++) {
    const a = rng() * TAU, d = rng() * r * 0.45;
    circles.push([Math.cos(a) * d, Math.sin(a) * d, r * (0.25 + rng() * 0.3)]);
  }
  const drops = 6 + Math.floor(rng() * 10);
  for (let i = 0; i < drops; i++) {
    const a = rng() * TAU, d = r * (0.75 + rng() * 1.0), rad = r * (0.04 + rng() * 0.1);
    circles.push([Math.cos(a) * d, Math.sin(a) * d, rad]);
    if (rng() < 0.4) circles.push([Math.cos(a) * d * 0.8, Math.sin(a) * d * 0.8, rad * 0.7]);
  }
  return { circles, tint: 0.9 + rng() * 0.1 };
}

// Each splat circle is treated as a sphere of paint centered in the hit plane.
// Every face it intersects gets painted, so splats wrap over edges and corners.
function paintSplat(sp) {
  const { circles, tint } = splatShape(sp.r, sp.s);
  const rgb = PALETTE_RGB[sp.c] || PALETTE_RGB[0];
  const t1 = (sp.a + 1) % 3, t2 = (sp.a + 2) % 3;
  const reach = sp.r * 2;
  const c3 = [0, 0, 0];

  for (const f of faces) {
    if (f.axis === sp.a && f.sign !== sp.sg) continue; // back sides
    if (Math.abs(sp.p[f.axis] - f.plane) > reach) continue;
    if (Math.max(f.umin - sp.p[f.ua], sp.p[f.ua] - f.umax) > reach) continue;
    if (Math.max(f.vmin - sp.p[f.va], sp.p[f.va] - f.vmax) > reach) continue;

    const k = f.shade * tint;
    f.ctx.fillStyle = `rgb(${rgb[0] * k | 0},${rgb[1] * k | 0},${rgb[2] * k | 0})`;
    f.ctx.beginPath();
    let drew = false;
    for (const [cx, cy, rad] of circles) {
      c3[0] = sp.p[0]; c3[1] = sp.p[1]; c3[2] = sp.p[2];
      c3[t1] += cx; c3[t2] += cy;
      const dist = Math.abs(c3[f.axis] - f.plane);
      if (dist >= rad) continue;
      const rr = Math.sqrt(rad * rad - dist * dist);
      const x = (c3[f.ua] - f.umin) * f.sx;
      const y = (f.vmax - c3[f.va]) * f.sy;
      f.ctx.moveTo(x + rr * f.sx, y);
      f.ctx.ellipse(x, y, rr * f.sx, rr * f.sy, 0, 0, TAU);
      drew = true;
    }
    if (drew) {
      f.ctx.fill();
      f.dirty = true;
    }
  }
}

function flushPaint() {
  for (const f of faces) {
    if (f.dirty) { f.tex.needsUpdate = true; f.dirty = false; }
  }
}

// ---------------------------------------------------------------- Materials & shared geometry

const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
// ?debug renders players in visible colors so they can be seen while developing.
const DEBUG = new URLSearchParams(location.search).has('debug');
const avatarMat = DEBUG ? new THREE.MeshNormalMaterial() : whiteMat;
const colorMats = PALETTE.map(hex => new THREE.MeshBasicMaterial({ color: hex }));
const dotGeo = new THREE.SphereGeometry(1, 10, 8);
const blobGeo = new THREE.SphereGeometry(C.BLOB_RADIUS * 1.3, 14, 10);

// ---------------------------------------------------------------- Viewmodel (your paint gun)

const viewGunShell = new THREE.MeshLambertMaterial({ color: 0xffffff });
const viewGunDark = new THREE.MeshLambertMaterial({ color: 0x2c2c30 });
const muzzle = new THREE.Object3D();
let viewGun = null;

function setupViewGun() {
  if (viewGun) return;
  viewGun = cloneGun(viewGunShell, viewGunDark);
  viewGun.rotation.y = Math.PI; // gun model points along +Z
  viewGun.scale.setScalar(0.5);
  muzzle.position.set(0, 0.085, 0.45);
  viewGun.add(muzzle);
  camera.add(viewGun);
}

function setGunColor(c) {
  viewGunShell.color.set(PALETTE[c]);
}

// ---------------------------------------------------------------- Sound

const STEP_LENGTH = 2.2; // meters between footsteps
const sfx = {
  shoot: () => play('shoot', { vol: 0.5 }) || tone(520, 170, 0.09, 'triangle', 0.14),
  shootAt: p => play('shoot', { pos: p, vol: 0.8 }),
  splat: p => play('splat', { pos: p, vol: 1 }) || tone(170, 45, 0.16, 'sine', 0.2),
  step: (p, vol) => play('footstep', { pos: p, vol, jitter: 0.12 }),
  hit: () => tone(1500, 1100, 0.05, 'square', 0.05),
  hurt: () => tone(240, 80, 0.25, 'sawtooth', 0.1),
  kill: () => { tone(500, 1000, 0.12, 'triangle', 0.14); setTimeout(() => tone(750, 1500, 0.16, 'triangle', 0.12), 90); },
};

// ---------------------------------------------------------------- State

const me = {
  id: null, color: 0, name: '', life: 0,
  p: [0, 0, 0], v: [0, 0, 0], onGround: false,
  yaw: 0, pitch: 0, hp: C.MAX_HP, alive: false,
  killedBy: null, respawnAt: 0, stepDist: 0,
};
const roster = new Map();      // id -> { id, name, color, kills, deaths }
const avatars = new Map();     // remote id -> avatar
const projectiles = new Map(); // key -> { mesh, p, v, born, offset }
const round = { state: 'lobby', endsAt: 0, goUntil: 0 };
let lobbyState = { players: [], leader: null };

let ws = null;
let leaving = false;
let screen = 'menu'; // menu | lobby | viewer | game

const lobby = createLobby(renderer, $('labels'), 420);
const viewer = createViewer(renderer, $('labels'));

function showScreen(name) {
  screen = name;
  $('menu').hidden = name !== 'menu';
  $('lobbyUi').hidden = name !== 'lobby';
  $('viewerUi').hidden = name !== 'viewer';
  $('hud').hidden = name !== 'game';
  lobby.hideLabels(name !== 'lobby');
  viewer.setActive(name === 'viewer');
  if (name !== 'game') {
    for (const id of ['scoreboard', 'roundEnd', 'pauseMenu']) $(id).hidden = true;
    $('vignette').style.opacity = 0;
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function addRoster(info) {
  roster.set(info.id, { id: info.id, name: info.name, color: info.color, kills: info.kills, deaths: info.deaths });
  if (info.id !== me.id && !avatars.has(info.id)) {
    const av = makeAvatar();
    av.group.position.set(...info.p);
    av.target.set(...info.p);
    av.yaw = av.targetYaw = info.yaw || 0;
    av.group.visible = info.alive;
    avatars.set(info.id, av);
  }
}

function removeRoster(id) {
  roster.delete(id);
  const av = avatars.get(id);
  if (av) { scene.remove(av.group); avatars.delete(id); }
}

function clearMatch() {
  for (const av of avatars.values()) scene.remove(av.group);
  avatars.clear();
  roster.clear();
  for (const key of [...projectiles.keys()]) removeProjectile(key);
}

// ---------------------------------------------------------------- Avatars

function makeAvatar() {
  const ch = createCharacter({ bodyMat: avatarMat, gunShellMat: avatarMat, gunDarkMat: avatarMat });
  scene.add(ch.root);
  return {
    ch, group: ch.root, dead: false, dots: [], stepDist: 0,
    target: new THREE.Vector3(), yaw: 0, targetYaw: 0, pitch: 0, targetPitch: 0,
    vel: new THREE.Vector3(),
  };
}

const _vel = new THREE.Vector3();

function updateAvatar(av, dt, k) {
  const pos = av.group.position;
  const prevX = pos.x, prevY = pos.y, prevZ = pos.z;
  pos.lerp(av.target, k);
  let d = av.targetYaw - av.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  av.yaw += d * k;
  av.group.rotation.y = av.yaw;
  av.pitch += (av.targetPitch - av.pitch) * k;
  if (dt > 0) {
    _vel.set((pos.x - prevX) / dt, (pos.y - prevY) / dt, (pos.z - prevZ) / dt);
    av.vel.lerp(_vel, 1 - Math.exp(-10 * dt));
  }

  let twist = 0;
  if (!av.dead) {
    const airborne = pos.y - groundHeight(pos.x, pos.z, pos.y + 0.3) > 0.3;
    twist = locomotion(av.ch, av.vel, av.yaw, airborne);
    const speed = Math.hypot(av.vel.x, av.vel.z);
    if (!airborne && speed > 1) {
      av.stepDist += speed * dt;
      if (av.stepDist > STEP_LENGTH) {
        av.stepDist = 0;
        sfx.step([pos.x, pos.y, pos.z], 0.9);
      }
    }
  }
  poseCharacter(av.ch, dt, { twist, pitch: av.pitch, upperBody: !av.dead });
}

const raycaster = new THREE.Raycaster();
const _p = new THREE.Vector3(), _axis = new THREE.Vector3(), _out = new THREE.Vector3();

// Finds the body surface near a world point by casting a ray from outside towards the
// body's vertical axis, and returns the hit point and the bone that owns it.
function surfaceAt(av, point) {
  _axis.set(av.group.position.x, point.y, av.group.position.z);
  _out.subVectors(point, _axis);
  if (_out.lengthSq() < 1e-6) _out.set(0, 0, 1);
  _out.normalize();
  raycaster.set(_p.copy(_axis).addScaledVector(_out, 1.2), _out.clone().negate());
  raycaster.far = 2;
  const skinned = av.ch.skinned;
  const hit = raycaster.intersectObject(skinned, false)[0];
  if (!hit) return null;
  const skinIndex = skinned.geometry.attributes.skinIndex;
  const skinWeight = skinned.geometry.attributes.skinWeight;
  const v = hit.face.a;
  let best = 0, bestW = -1;
  for (let i = 0; i < 4; i++) {
    const w = skinWeight.getComponent(v, i);
    if (w > bestW) { bestW = w; best = skinIndex.getComponent(v, i); }
  }
  return { point: hit.point, bone: skinned.skeleton.bones[best] };
}

// Paint sticks to the bone under the hit, so it moves with arms and legs.
function paintAvatar(av, off, color, seed) {
  const rng = mulberry32(seed);
  const base = av.group.position;
  const center = new THREE.Vector3(base.x + off[0], base.y + off[1], base.z + off[2]);
  av.group.updateMatrixWorld(true);
  av.ch.skinned.computeBoundingSphere();
  const count = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const spread = i === 0 ? 0 : 0.22;
    const q = center.clone().add(new THREE.Vector3((rng() - 0.5) * spread, (rng() - 0.5) * spread * 1.4, (rng() - 0.5) * spread));
    const s = i === 0 ? 0.13 + rng() * 0.05 : 0.04 + rng() * 0.06;
    const hit = surfaceAt(av, q);
    if (!hit) continue;
    const dot = new THREE.Mesh(dotGeo, colorMats[color] || colorMats[0]);
    hit.bone.add(dot);
    dot.position.copy(hit.bone.worldToLocal(hit.point.clone()));
    // bones may be scaled (the model is), keep the dot size in world units
    dot.scale.setScalar(s / hit.bone.getWorldScale(_p).x);
    av.dots.push(dot);
  }
  while (av.dots.length > 120) av.dots.shift().removeFromParent();
}

function clearAvatarPaint(av) {
  for (const d of av.dots) d.removeFromParent();
  av.dots.length = 0;
}

function killAvatar(av) {
  av.dead = true;
  setAnim(av.ch, 'death', 0.15);
}

function reviveAvatar(av, p) {
  clearAvatarPaint(av);
  av.dead = false;
  av.group.position.set(...p);
  av.target.set(...p);
  av.vel.set(0, 0, 0);
  const ch = av.ch;
  if (ch.state !== 'idle') ch.actions[ch.state].stop();
  ch.actions.idle.reset();
  ch.actions.idle.setEffectiveWeight(1);
  ch.actions.idle.play();
  ch.state = 'idle';
  av.group.visible = true;
}

// ---------------------------------------------------------------- Projectiles

function spawnProjectile(key, o, v, color, offset) {
  const mesh = new THREE.Mesh(blobGeo, colorMats[color] || colorMats[0]);
  mesh.position.set(...o);
  scene.add(mesh);
  projectiles.set(key, { mesh, p: o.slice(), v: v.slice(), born: performance.now(), offset });
}

function removeProjectile(key) {
  const pr = projectiles.get(key);
  if (!pr) return;
  scene.remove(pr.mesh);
  projectiles.delete(key);
}

function updateProjectiles(dt) {
  const now = performance.now();
  for (const [key, pr] of projectiles) {
    const { hit } = stepProjectile(pr, dt);
    // The server decides impacts; locally we only hide blobs that hit a wall.
    if (hit || now - pr.born > C.BLOB_LIFETIME * 1000) { removeProjectile(key); continue; }
    pr.mesh.position.set(...pr.p);
    if (pr.offset) {
      // Start the blob at the gun muzzle and blend onto the true aim line.
      const k = Math.max(0, 1 - (now - pr.born) / 120);
      pr.mesh.position.addScaledVector(pr.offset, k);
    }
  }
}

let shotCounter = 0;
let lastShot = 0;
const pendingShots = new Map(); // client shot id -> projectile key

function shoot() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const eye = camera.position;
  const o = [eye.x + dir.x * C.MUZZLE_OFFSET, eye.y + dir.y * C.MUZZLE_OFFSET, eye.z + dir.z * C.MUZZLE_OFFSET];
  const d = [dir.x, dir.y, dir.z];
  const cid = ++shotCounter;
  const muzzlePos = new THREE.Vector3();
  muzzle.getWorldPosition(muzzlePos);
  const offset = muzzlePos.sub(new THREE.Vector3(...o));
  const key = 'c' + cid;
  spawnProjectile(key, o, d.map(x => x * C.BLOB_SPEED), me.color, offset);
  pendingShots.set(cid, key);
  send({ t: 'shoot', cid, o, d });
  recoil = 1;
  sfx.shoot();
}

// ---------------------------------------------------------------- Networking

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(name, color) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  leaving = false;
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => send({ t: 'join', name, color });
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    clearMatch();
    showScreen('menu');
    $('play').disabled = false;
    $('menuError').textContent = leaving ? '' : 'Disconnected from server.';
  };
  ws.onerror = () => { $('menuError').textContent = 'Could not reach the server.'; };
}

function leave() {
  leaving = true;
  if (ws) ws.close();
}

function enterGame(m) {
  clearMatch();
  for (const p of m.players) addRoster(p);
  clearPaint();
  for (const sp of m.splats) paintSplat(sp);
  setRound(m.round);
  me.alive = false;
  me.killedBy = null;
  me.hp = C.MAX_HP;
  showScreen('game');
  $('roundEnd').hidden = true;
  renderBoard();
  if (m.round.state === 'loading') {
    // Tell the server once the level is on screen.
    requestAnimationFrame(() => requestAnimationFrame(() => send({ t: 'ready' })));
  }
}

function handle(m) {
  switch (m.t) {
    case 'welcome':
      me.id = m.id;
      me.life = m.life;
      if (m.phase === 'lobby') showScreen('lobby');
      else enterGame(m);
      break;
    case 'lobby':
      lobbyState = m;
      if (m.phase === 'lobby' && screen === 'game') {
        clearMatch();
        showScreen('lobby');
      }
      renderLobby();
      break;
    case 'start':
      enterGame(m);
      break;
    case 'join':
      addRoster(m.player);
      if (screen === 'game') feed(`${nameTag(m.player.id)} joined`);
      renderBoard();
      break;
    case 'leave':
      if (screen === 'game' && roster.has(m.id)) feed(`${nameTag(m.id)} left`);
      removeRoster(m.id);
      renderBoard();
      break;
    case 'st':
      for (const [id, x, y, z, yaw, pitch] of m.l) {
        const av = avatars.get(id);
        if (!av || av.dead) continue;
        av.target.set(x, y, z);
        av.targetYaw = yaw;
        av.targetPitch = pitch;
      }
      break;
    case 'ack': {
      const key = pendingShots.get(m.cid);
      pendingShots.delete(m.cid);
      const pr = key && projectiles.get(key);
      if (pr) { projectiles.delete(key); projectiles.set(m.id, pr); }
      break;
    }
    case 'shot':
      spawnProjectile(m.id, m.o, m.v, m.c, null);
      sfx.shootAt(m.o);
      break;
    case 'splat':
      removeProjectile(m.id);
      paintSplat(m);
      sfx.splat(m.p);
      break;
    case 'hitp': {
      removeProjectile(m.id);
      const hitAv = avatars.get(m.target);
      if (m.target === me.id) {
        me.hp = m.hp;
        hurtFlash = 0.6;
        splashScreen(m.c);
        sfx.hurt();
        sfx.splat([me.p[0], me.p[1] + 1.2, me.p[2]]);
      } else if (hitAv) {
        paintAvatar(hitAv, m.off, m.c, m.s);
        sfx.splat(hitAv.group.position.toArray());
      }
      if (m.owner === me.id) { hitMarker(false); sfx.hit(); }
      break;
    }
    case 'hp':
      me.hp = m.hp;
      break;
    case 'kill': {
      const killer = roster.get(m.killer);
      const victim = roster.get(m.victim);
      if (killer) killer.kills = m.kk;
      if (victim) victim.deaths = m.vd;
      feed(`${nameTag(m.killer)} splatted ${nameTag(m.victim)}`);
      if (m.victim === me.id) {
        me.alive = false;
        me.hp = 0;
        me.killedBy = m.killer;
        me.respawnAt = performance.now() + C.RESPAWN_TIME * 1000;
        firing = false;
      } else {
        const av = avatars.get(m.victim);
        if (av) killAvatar(av);
      }
      if (m.killer === me.id && m.victim !== me.id) {
        hitMarker(true);
        sfx.kill();
        toast(`You splatted ${victim ? victim.name : 'someone'}`);
      }
      renderBoard();
      break;
    }
    case 'respawn':
      if (m.id === me.id) {
        me.life = m.life;
        placeMe(m.p);
      } else {
        const av = avatars.get(m.id);
        if (av) reviveAvatar(av, m.p);
      }
      break;
    case 'round':
      setRound(m.round);
      if (m.round.state === 'playing') round.goUntil = performance.now() + 900;
      if (m.round.state === 'ended') showRoundEnd(m.scores);
      break;
  }
}

function placeMe(p) {
  me.p = p.slice();
  me.v = [0, 0, 0];
  me.onGround = false;
  me.hp = C.MAX_HP;
  me.alive = true;
  me.killedBy = null;
  me.yaw = Math.atan2(p[0], p[2]); // face the arena center
  me.pitch = 0;
}

function setRound(r) {
  round.state = r.state;
  round.endsAt = performance.now() + r.remaining;
}

// ---------------------------------------------------------------- Lobby UI

const CROWN = '<svg class="crown" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 14 L0 3 L7 8 L12 0 L17 8 L24 3 L22 14 Z"/></svg>';

function renderLobby() {
  const { players, leader } = lobbyState;
  const isLeader = leader === me.id;
  const leaderName = players.find(p => p.id === leader)?.name ?? 'the leader';
  $('lobbyList').innerHTML = players.map(p => `
    <li>
      <span class="dot" style="background:${PALETTE[p.color]}"></span>
      ${p.id === leader ? CROWN : ''}
      <span>${esc(p.name)}</span>
      ${p.id === me.id ? '<span class="tag">you</span>' : ''}
    </li>`).join('');
  const n = players.length;
  if (lobbyState.phase && lobbyState.phase !== 'lobby') {
    $('lobbyStatus').textContent = 'A match is running, you will join it shortly.';
  } else {
    $('lobbyStatus').textContent = isLeader
      ? `${n} player${n === 1 ? '' : 's'} here. You lead this lobby, start when everyone is ready.`
      : `${n} player${n === 1 ? '' : 's'} here. Waiting for ${leaderName} to start the match.`;
  }
  $('startMatch').hidden = !isLeader;
  lobby.setPlayers(players, leader, me.id);
}

$('startMatch').addEventListener('click', () => {
  initAudio();
  lockPointer();
  send({ t: 'start' });
});
$('openViewer').addEventListener('click', () => showScreen('viewer'));
$('closeViewer').addEventListener('click', () => showScreen('lobby'));
$('leaveLobby').addEventListener('click', leave);

// ---------------------------------------------------------------- HUD

const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

function nameTag(id) {
  const r = roster.get(id);
  if (!r) return '<b>someone</b>';
  return `<b style="color:${PALETTE[r.color] === '#ffcc00' ? '#c79a00' : PALETTE[r.color]}">${esc(r.name)}</b>`;
}

function feed(html) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.innerHTML = html;
  $('feed').prepend(el);
  setTimeout(() => el.remove(), 5000);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1400);
}

let hitTimer = 0;
function hitMarker(isKill) {
  const el = $('hitmarker');
  el.classList.add('on');
  el.classList.toggle('kill', isKill);
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => el.classList.remove('on', 'kill'), isKill ? 350 : 120);
}

function splashScreen(color) {
  const el = $('splash');
  const hex = PALETTE[color];
  const blobs = [];
  for (let i = 0; i < 4; i++) {
    const x = 10 + Math.random() * 80, y = 10 + Math.random() * 80, s = 12 + Math.random() * 22;
    blobs.push(`radial-gradient(circle at ${x}% ${y}%, ${hex} 0, ${hex} ${s * 0.6}%, transparent ${s}%)`);
  }
  el.style.background = blobs.join(',');
  el.style.transition = 'none';
  el.style.opacity = '0.55';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transition = 'opacity 1.2s ease-out';
    el.style.opacity = '0';
  }));
}

// Red screen edges get stronger the more hurt you are; hits add a short pulse.
let hurtFlash = 0;
let vignetteLevel = 0;
function updateVignette(dt) {
  hurtFlash = Math.max(0, hurtFlash - dt * 1.5);
  const hurt = me.alive ? Math.pow(1 - Math.max(0, me.hp) / C.MAX_HP, 0.8) : 0;
  vignetteLevel += (hurt - vignetteLevel) * Math.min(1, 4 * dt);
  $('vignette').style.opacity = Math.min(1, vignetteLevel * 0.9 + hurtFlash).toFixed(3);
}

function sortedRoster() {
  return [...roster.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
}

function renderBoard() {
  $('board').innerHTML = sortedRoster().slice(0, 6).map(r => `
    <div class="row${r.id === me.id ? ' me' : ''}">
      <span class="dot" style="background:${PALETTE[r.color]}"></span>
      <span class="n">${esc(r.name)}</span>
      <span class="k">${r.kills}</span>
    </div>`).join('');
  if (!$('scoreboard').hidden) renderScoreboard();
}

function scoreTable(list) {
  return `<table>
    <tr><th>Player</th><th class="num">Kills</th><th class="num">Deaths</th></tr>
    ${list.map(r => `<tr class="${r.id === me.id ? 'me' : ''}">
      <td><span class="swatch" style="background:${PALETTE[r.color]}"></span>${esc(r.name)}</td>
      <td class="num">${r.kills}</td><td class="num">${r.deaths}</td></tr>`).join('')}
  </table>`;
}

function renderScoreboard() {
  $('scoreboard').innerHTML = `<h2>Scores</h2>${scoreTable(sortedRoster())}`;
}

function showRoundEnd(scores) {
  const top = scores[0];
  const tie = scores.length > 1 && scores[1].kills === top?.kills;
  const title = !top ? 'Round over' : tie ? 'Draw!' : `${esc(top.name)} wins!`;
  $('roundEnd').innerHTML = `<h2>${title}</h2><p class="sub" id="nextRound"></p>${scoreTable(scores)}`;
  $('roundEnd').hidden = false;
  firing = false;
}

const fmtTime = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let lastBoardRender = 0;
function updateHud(now, dt) {
  const left = round.endsAt - now;
  const cd = $('countdown');
  cd.classList.remove('go');
  if (round.state === 'loading') {
    $('timer').textContent = fmtTime(C.ROUND_TIME * 1000);
    cd.innerHTML = '<span class="sub">Waiting for all players to load…</span>';
  } else if (round.state === 'countdown') {
    $('timer').textContent = fmtTime(C.ROUND_TIME * 1000);
    cd.innerHTML = `${Math.max(1, Math.ceil(left / 1000))}<span class="sub">Get ready</span>`;
  } else if (round.state === 'playing') {
    $('timer').textContent = fmtTime(left);
    if (now < round.goUntil) { cd.textContent = 'GO!'; cd.classList.add('go'); } else cd.textContent = '';
  } else {
    $('timer').textContent = '0:00';
    cd.textContent = '';
    const nr = $('nextRound');
    if (nr) nr.textContent = `Back to the lobby in ${Math.max(0, Math.ceil(left / 1000))}s`;
  }

  const dead = !me.alive && me.killedBy !== null && round.state === 'playing';
  if (dead) {
    const s = Math.max(0, Math.ceil((me.respawnAt - now) / 1000));
    $('centerMsg').innerHTML = `<span class="big">SPLATTED</span>by ${nameTag(me.killedBy)} · back in ${s}`;
  } else {
    $('centerMsg').innerHTML = '';
  }

  // Stats: hold Tab, or automatically while waiting to respawn.
  const showBoard = (tabHeld || dead) && $('roundEnd').hidden;
  if (showBoard && (now - lastBoardRender > 250 || $('scoreboard').hidden)) {
    renderScoreboard();
    lastBoardRender = now;
  }
  $('scoreboard').hidden = !showBoard;

  $('pauseMenu').hidden = locked();
  $('pauseTitle').textContent = round.state === 'loading' || round.state === 'countdown' ? 'Match starting' : 'Menu';
  updateVignette(dt);
}

// ---------------------------------------------------------------- Input

const keys = new Set();
let firing = false;
let jumpQueued = false;
let tabHeld = false;
let recoil = 0;
const SENS = 0.0022;

document.addEventListener('keydown', e => {
  if (screen !== 'game') return;
  if (e.code === 'Tab') {
    e.preventDefault();
    tabHeld = true;
    return;
  }
  keys.add(e.code);
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Tab') tabHeld = false;
  keys.delete(e.code);
});
window.addEventListener('blur', () => { keys.clear(); firing = false; tabHeld = false; });

const locked = () => document.pointerLockElement === renderer.domElement;
function lockPointer() {
  const p = renderer.domElement.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
}

document.addEventListener('mousemove', e => {
  if (screen !== 'game' || !locked() || !me.alive) return;
  me.yaw -= e.movementX * SENS;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * SENS));
});
document.addEventListener('mousedown', e => {
  if (e.button === 0 && locked() && screen === 'game') firing = true;
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) firing = false;
});
document.addEventListener('pointerlockchange', () => {
  if (!locked()) firing = false;
});

// ---------------------------------------------------------------- Pause menu (Esc)

{
  const slider = $('volume');
  const show = () => { $('volumeValue').textContent = `${slider.value}%`; };
  slider.value = Math.round(getVolume() * 100);
  show();
  slider.addEventListener('input', () => { setVolume(slider.value / 100); show(); });
  slider.addEventListener('change', () => { initAudio(); sfx.shoot(); });
  $('resume').addEventListener('click', () => { initAudio(); lockPointer(); });
  $('leaveMatch').addEventListener('click', leave);
}

// ---------------------------------------------------------------- Menu

{
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('splatter') || '{}'); } catch {}
  let color = Number.isInteger(saved.color) && saved.color < PALETTE.length ? saved.color : Math.floor(Math.random() * PALETTE.length);
  $('name').value = saved.name || '';

  $('logo').innerHTML = [...'SPLATTER'].map((ch, i) => `<span style="color:${PALETTE[(i * 3) % PALETTE.length]}">${ch}</span>`).join('');

  const pal = $('palette');
  PALETTE.forEach((hex, i) => {
    const b = document.createElement('button');
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => {
      color = i;
      [...pal.children].forEach((el, j) => el.classList.toggle('sel', j === i));
    });
    pal.appendChild(b);
  });
  pal.children[color].classList.add('sel');

  assetsReady.catch(() => { $('menuError').textContent = 'Could not load the player model.'; });

  const join = async () => {
    const name = $('name').value.trim();
    try { localStorage.setItem('splatter', JSON.stringify({ name, color })); } catch {}
    me.color = color;
    $('menuError').textContent = '';
    $('play').disabled = true;
    initAudio();
    try {
      await assetsReady;
    } catch {
      $('play').disabled = false;
      return;
    }
    setupViewGun();
    setGunColor(color);
    connect(name, color);
  };
  $('play').addEventListener('click', join);
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
}

// ---------------------------------------------------------------- Main loop

let lastFrame = performance.now();
let stateTimer = 0;
let wasOnGround = true;

function gameFrame(now, dt) {
  if (me.alive) {
    const canMove = locked() && round.state === 'playing';
    const inp = {
      f: canMove ? (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) : 0,
      r: canMove ? (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) : 0,
      jump: canMove && (jumpQueued || keys.has('Space')),
      yaw: me.yaw,
    };
    jumpQueued = false;
    movePlayer(me, inp, dt);
    if (me.p[1] < -20) placeMe(LEVEL.spawns[0]);

    // Footsteps
    const speed = Math.hypot(me.v[0], me.v[2]);
    if (me.onGround && speed > 1) {
      me.stepDist += speed * dt;
      if (me.stepDist > STEP_LENGTH) { me.stepDist = 0; play('footstep', { vol: 0.35, jitter: 0.12 }); }
    }
    if (me.onGround && !wasOnGround) play('footstep', { vol: 0.5, jitter: 0.05 });
    wasOnGround = me.onGround;

    if (firing && round.state === 'playing' && now - lastShot >= C.FIRE_INTERVAL * 1000) {
      lastShot = now;
      shoot();
    }

    stateTimer += dt;
    if (stateTimer >= 1 / C.STATE_RATE) {
      stateTimer = 0;
      send({ t: 's', p: me.p.map(x => Math.round(x * 1000) / 1000), y: me.yaw, x: me.pitch, l: me.life });
    }
  }

  camera.position.set(me.p[0], me.p[1] + C.EYE_HEIGHT, me.p[2]);
  camera.rotation.set(me.pitch, me.yaw, 0);
  camera.updateMatrixWorld();
  updateListener(camera);

  if (viewGun) {
    viewGun.visible = me.alive;
    recoil = Math.max(0, recoil - dt * 9);
    const speed = Math.hypot(me.v[0], me.v[2]);
    const bob = me.onGround ? Math.sin(now / 90) * Math.min(1, speed / C.MOVE_SPEED) : 0;
    viewGun.position.set(0.2 + bob * 0.006, -0.21 + Math.abs(bob) * 0.008 + recoil * 0.012, -0.42 + recoil * 0.04);
    viewGun.rotation.x = recoil * 0.2;
  }

  const k = 1 - Math.exp(-15 * dt);
  for (const av of avatars.values()) updateAvatar(av, dt, k);

  updateProjectiles(dt);
  updateHud(now, dt);
  flushPaint();
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (screen === 'game') gameFrame(now, dt);
  else if (screen === 'lobby') lobby.render(dt);
  else if (screen === 'viewer') viewer.render(dt);
});

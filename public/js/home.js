// Main menu scene for logged-in players: their character dances in front of a wall while
// paint shots in every color fly past and splat onto the wall and the floor. Old paint
// slowly fades, so the wall never fills up.

import * as THREE from 'three';
import { PALETTE, mulberry32 } from '/shared/game.js';
import { createCharacter, poseCharacter, setAnim, funClipNames } from './characters.js';
import { createFluid } from './fluid.js';

const BG = '#f3f3f5';
const WALL = { w: 22, h: 9, z: -2.6 };
const FLOOR = { w: 22, d: 9, z0: WALL.z, px: 70 }; // floor from the wall towards the camera
const PX = 80;                                     // canvas pixels per meter on the wall
const GRAVITY = 9;
const TAU = Math.PI * 2;

// A canvas the paint is drawn into, shown on a plane.
function paintLayer(wPx, hPx) {
  const canvas = document.createElement('canvas');
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, wPx, hPx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, ctx, tex, dirty: false };
}

// Splat: a lumpy body, droplets flung around it and, on the wall, drips running down.
function drawSplat(layer, x, y, r, color, seed, drips) {
  const { ctx } = layer;
  const rng = mulberry32(seed);
  const col = new THREE.Color(color);
  const dark = col.clone().multiplyScalar(0.8).getStyle();
  const light = col.clone().lerp(new THREE.Color(1, 1, 1), 0.45).getStyle();
  const circles = [[0, 0, r * 0.55]];
  for (let i = 0, n = 6 + Math.floor(rng() * 5); i < n; i++) {
    const a = rng() * TAU, d = rng() * r * 0.5;
    circles.push([Math.cos(a) * d, Math.sin(a) * d, r * (0.22 + rng() * 0.32)]);
  }
  for (let i = 0, n = 6 + Math.floor(rng() * 10); i < n; i++) {
    const a = rng() * TAU, d = r * (0.75 + rng() * 1.0), rad = r * (0.04 + rng() * 0.1);
    circles.push([Math.cos(a) * d, Math.sin(a) * d, rad]);
    if (rng() < 0.4) circles.push([Math.cos(a) * d * 0.8, Math.sin(a) * d * 0.8, rad * 0.7]);
  }
  const fill = (grow, style) => {
    ctx.fillStyle = style;
    ctx.beginPath();
    for (const [cx, cy, cr] of circles) {
      ctx.moveTo(x + cx + cr + grow, y + cy);
      ctx.arc(x + cx, y + cy, cr + grow, 0, TAU);
    }
    ctx.fill();
  };
  fill(r * 0.04, dark);          // darker rim
  fill(0, col.getStyle());
  // a soft wet highlight on the upper left of the body
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.ellipse(x - r * 0.18, y - r * 0.2, r * 0.2, r * 0.09, -0.6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  layer.dirty = true;
  if (!drips) return [];
  // drips start at the bottom of the body and grow over the next seconds
  const out = [];
  for (let i = 0, n = 1 + Math.floor(rng() * 3); i < n; i++) {
    out.push({
      layer, x: x + (rng() - 0.5) * r, y: y + r * 0.3, len: 0,
      max: r * (0.8 + rng() * 2.2), w: r * (0.06 + rng() * 0.07), speed: r * (0.6 + rng() * 0.8), style: col.getStyle(),
    });
  }
  return out;
}

export function createHome(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 14, 30);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc8ccd4, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 7, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -3, near: 1, far: 25 });
  scene.add(sun);

  const wall = paintLayer(WALL.w * PX, WALL.h * PX);
  const wallMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(WALL.w, WALL.h),
    new THREE.MeshStandardMaterial({ map: wall.tex, roughness: 0.55 }),
  );
  wallMesh.position.set(0, WALL.h / 2, WALL.z);
  wallMesh.receiveShadow = true;
  scene.add(wallMesh);

  const floor = paintLayer(FLOOR.w * FLOOR.px, FLOOR.d * FLOOR.px);
  const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR.w, FLOOR.d),
    new THREE.MeshStandardMaterial({ map: floor.tex, roughness: 0.7 }),
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(0, 0, FLOOR.z0 + FLOOR.d / 2);
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // The player stands in the middle band, clear of the name at the top and the
  // button and colors at the bottom.
  const CAM_Z = 7.6;
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
  const aimCamera = z => { camera.position.set(0, 1.5, z); camera.lookAt(0, 1.12, 0.6); };
  aimCamera(CAM_Z);

  const fluid = createFluid(renderer);

  // --- the player
  const body = new THREE.MeshStandardMaterial({ roughness: 0.5 });
  // no gun here, just one of the silly lobby loops
  const ch = createCharacter({ bodyMat: body, castShadow: true });
  ch.root.position.set(0, 0, 0.6);
  ch.root.rotation.y = Math.PI - 0.35; // facing the camera, turned a little
  scene.add(ch.root);

  function setColor(i) {
    body.color.set(PALETTE[i] ?? PALETTE[0]);
  }

  // A random dance, a different one each time the menu shows.
  function dance() {
    const clips = funClipNames().filter(c => c !== ch.state);
    setAnim(ch, clips[Math.floor(Math.random() * clips.length)], 0.3);
  }
  dance();

  // --- paint shots
  const shots = [];
  const drips = [];
  const rand = (a, b) => a + Math.random() * (b - a);
  const paintColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

  function toWall(x, y) { return [(x + WALL.w / 2) * PX, (WALL.h - y) * PX]; }
  function toFloor(x, z) { return [(x + FLOOR.w / 2) * FLOOR.px, (z - FLOOR.z0) * FLOOR.px]; }

  function fire() {
    // from off screen at the sides, or from behind the camera, towards the wall or floor
    const side = Math.random();
    const start = side < 0.4
      ? new THREE.Vector3(rand(-11, -8), rand(0.8, 3.5), rand(-1, 4))
      : side < 0.8
        ? new THREE.Vector3(rand(8, 11), rand(0.8, 3.5), rand(-1, 4))
        : new THREE.Vector3(rand(-3, 3), rand(1.5, 3), 8);
    const onFloor = Math.random() < 0.25;
    let target;
    if (onFloor) {
      // not right at the player's feet
      let x = rand(-6, 6);
      if (Math.abs(x) < 1.2) x += Math.sign(x || 1) * 1.2;
      target = new THREE.Vector3(x, 0, rand(WALL.z + 0.3, 1.5));
    } else {
      target = new THREE.Vector3(rand(-7, 7), rand(0.4, 4.5), WALL.z);
    }
    const dist = start.distanceTo(target);
    const T = dist / rand(11, 16);
    // aim so gravity carries the blob onto the target at time T
    const v = target.clone().sub(start).divideScalar(T);
    v.y += 0.5 * GRAVITY * T;
    shots.push({ start, v, T, t: 0, color: paintColor(), onFloor, target, pos: start.clone() });
  }

  function impact(s) {
    const r = rand(0.35, 0.7);
    const seed = (Math.random() * 0x7fffffff) | 0;
    if (s.onFloor) {
      const [x, y] = toFloor(s.target.x, s.target.z);
      drawSplat(floor, x, y, r * FLOOR.px, s.color, seed, false);
      fluid.splash(s.target.toArray(), [0, 1, 0], s.color, { count: 12, speed: 2.8, size: 0.09, life: 0.6 });
    } else {
      const [x, y] = toWall(s.target.x, s.target.y);
      drips.push(...drawSplat(wall, x, y, r * PX, s.color, seed, true));
      fluid.splash(s.target.toArray(), [0, 0, 1], s.color, { count: 14, speed: 3, size: 0.09, life: 0.6 });
    }
  }

  // a painted wall from the start
  for (let i = 0; i < 14; i++) {
    const [x, y] = toWall(rand(-8, 8), rand(0.3, 5));
    drawSplat(wall, x, y, rand(0.3, 0.75) * PX, paintColor(), (Math.random() * 1e9) | 0, false);
  }
  for (let i = 0; i < 6; i++) {
    const [x, y] = toFloor(rand(-7, 7), rand(WALL.z + 0.4, 1.5));
    drawSplat(floor, x, y, rand(0.3, 0.6) * FLOOR.px, paintColor(), (Math.random() * 1e9) | 0, false);
  }

  let nextShot = 0.4;
  let fadeTimer = 0;
  let uploadTimer = 0;
  let width = 0, height = 0;
  let time = 0;
  const _head = new THREE.Vector3(), _dir = new THREE.Vector3();

  function update(dt) {
    time += dt;
    nextShot -= dt;
    if (nextShot <= 0) {
      fire();
      if (Math.random() < 0.3) fire(); // now and then a quick double shot
      nextShot = rand(0.25, 0.75);
    }
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.t += dt;
      if (s.t >= s.T) { impact(s); shots.splice(i, 1); continue; }
      const t = s.t;
      _head.copy(s.start).addScaledVector(s.v, t);
      _head.y -= 0.5 * GRAVITY * t * t;
      _dir.copy(s.v); _dir.y -= GRAVITY * t; _dir.normalize();
      // a gooey drop with a short tail, like the shots in the game
      fluid.blob(_head.clone(), 0.13, s.color);
      fluid.blob(_head.clone().addScaledVector(_dir, -0.1), 0.1, s.color);
      fluid.blob(_head.clone().addScaledVector(_dir, -0.19), 0.07, s.color);
    }
    for (let i = drips.length - 1; i >= 0; i--) {
      const d = drips[i];
      const step = Math.min(d.max - d.len, d.speed * dt);
      const { ctx } = d.layer;
      ctx.strokeStyle = d.style;
      ctx.lineWidth = d.w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(d.x, d.y + d.len);
      ctx.lineTo(d.x, d.y + d.len + step);
      ctx.stroke();
      d.len += step;
      d.speed *= Math.exp(-0.7 * dt); // runs slow down
      d.layer.dirty = true;
      if (d.len >= d.max || d.speed < 2) drips.splice(i, 1);
    }
    // old paint fades back to white (in steps big enough not to get lost in 8-bit rounding)
    fadeTimer += dt;
    if (fadeTimer > 2) {
      fadeTimer = 0;
      for (const layer of [wall, floor]) {
        layer.ctx.globalAlpha = 0.08;
        layer.ctx.fillStyle = BG;
        layer.ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.globalAlpha = 1;
        layer.dirty = true;
      }
    }
    // upload the canvases at most ~15 times a second, drips grow smoothly enough
    uploadTimer += dt;
    if (uploadTimer > 1 / 15) {
      uploadTimer = 0;
      for (const layer of [wall, floor]) {
        if (layer.dirty) { layer.tex.needsUpdate = true; layer.dirty = false; }
      }
    }
    fluid.update(dt);
  }

  function render(dt) {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    if (w !== width || h !== height) {
      width = w; height = h;
      camera.aspect = w / h;
      // keep the player in view on narrow screens
      aimCamera(w / h < 1 ? CAM_Z / Math.max(0.55, w / h) : CAM_Z);
      camera.updateProjectionMatrix();
    }
    update(dt);
    poseCharacter(ch, dt, { holdGun: false, upperBody: false });
    fluid.render(scene, camera);
  }

  return { render, setColor, dance };
}

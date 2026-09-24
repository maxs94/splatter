import * as THREE from 'three';
import { CONFIG as C, PALETTE, LEVEL, movePlayer, stepProjectile, mulberry32, groundHeight } from '/shared/game.js';
import { initAudio, play, tone, updateListener, getVolume, setVolume } from './js/audio.js';
import { assetsReady, createCharacter, cloneGun, locomotion, poseCharacter, setAnim } from './js/characters.js';
import { createLobby } from './js/lobby.js';
import { createViewer } from './js/viewer.js';
import { createPaintFlow, SIM_PPM } from './js/paintflow.js';
import { createFluid } from './js/fluid.js';
import { createRagdoll } from './js/ragdoll.js';
import { perf } from './js/perf.js';

const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const PALETTE_RGB = PALETTE.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

// ---------------------------------------------------------------- Renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.info.autoReset = false; // counted per frame (several passes), reset in gameFrame
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

const PPM = 32; // texture pixels per meter
// Per-face brightness so painted areas read as 3D: +x, -x, +y, -y, +z, -z
const SHADE = [0.8, 0.7, 1.0, 0.55, 0.9, 0.78];
const faces = [];
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// Paint edges come from a separate coverage mask: bilinear filtering of the mask gives
// smooth curves, and the shader cuts a sharp, anti-aliased edge at 50% coverage, so
// borders stay smooth even though the paint textures are low resolution. The color
// texture is painted slightly larger than the mask so edges don't get a light fringe.
const PAINT_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const PAINT_FRAGMENT = `
  uniform sampler2D map;
  uniform sampler2D mask;
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(map, vUv).rgb;
    float m = texture2D(mask, vUv).r;
    float w = max(fwidth(m) * 0.7, 0.002);
    float e = smoothstep(0.5 - w, 0.5 + w, m);
    gl_FragColor = vec4(mix(vec3(1.0), col, e), 1.0);
    #include <colorspace_fragment>
  }`;

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
      // Paint is read back for the drip simulation and footprints, so keep canvases on the CPU.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
      mctx.fillStyle = '#000';
      mctx.fillRect(0, 0, canvas.width, canvas.height);
      const mtex = new THREE.CanvasTexture(maskCanvas);
      mtex.colorSpace = THREE.NoColorSpace;
      mtex.anisotropy = maxAniso;

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
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, mask: { value: mtex } },
        vertexShader: PAINT_VERTEX, fragmentShader: PAINT_FRAGMENT, side: THREE.DoubleSide,
      }));
      scene.add(mesh);

      faces.push({
        axis, sign, ua, va, plane, umin, umax, vmin, vmax, canvas, ctx, tex, maskCanvas, mctx, mtex,
        sx: canvas.width / (umax - umin), sy: canvas.height / (vmax - vmin),
        shade: SHADE[axis * 2 + (sign > 0 ? 0 : 1)], dirty: false, floor: !!b.floor,
      });
    }
  }
}

function clearPaint() {
  for (const f of faces) {
    f.ctx.fillStyle = '#fff';
    f.ctx.fillRect(0, 0, f.canvas.width, f.canvas.height);
    f.mctx.fillStyle = '#000';
    f.mctx.fillRect(0, 0, f.canvas.width, f.canvas.height);
    f.dirty = true;
  }
  paintFlow.clear();
  clearFootprints();
}

// Splat shape in the hit plane: a lumpy core, flung droplets and a few streaks.
function splatShape(r, seed) {
  const rng = mulberry32(seed);
  const circles = [[0, 0, r * 0.55]];
  const lumps = 6 + Math.floor(rng() * 5);
  for (let i = 0; i < lumps; i++) {
    const a = rng() * TAU, d = rng() * r * 0.5;
    circles.push([Math.cos(a) * d, Math.sin(a) * d, r * (0.22 + rng() * 0.32)]);
  }
  const drops = 6 + Math.floor(rng() * 10);
  for (let i = 0; i < drops; i++) {
    const a = rng() * TAU, d = r * (0.75 + rng() * 1.0), rad = r * (0.04 + rng() * 0.1);
    circles.push([Math.cos(a) * d, Math.sin(a) * d, rad]);
    if (rng() < 0.4) circles.push([Math.cos(a) * d * 0.8, Math.sin(a) * d * 0.8, rad * 0.7]);
  }
  return { circles, tint: 0.9 + rng() * 0.1, rng };
}

const rgbStr = (c, k = 1) => `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
const mixWhite = (c, t) => [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];

// Paint circles into one face in three layers so the paint reads as a thick, wet
// blob: a darker rim, the body, and glossy highlights towards the upper left.
function paintCircles(f, sp, circles, base, mask = true) {
  const t1 = (sp.a + 1) % 3, t2 = (sp.a + 2) % 3;
  const c3 = [0, 0, 0];
  const hits = [];
  for (const [cx, cy, rad] of circles) {
    c3[0] = sp.p[0]; c3[1] = sp.p[1]; c3[2] = sp.p[2];
    c3[t1] += cx; c3[t2] += cy;
    const dist = Math.abs(c3[f.axis] - f.plane);
    if (dist >= rad) continue;
    const rr = Math.sqrt(rad * rad - dist * dist) * f.sx;
    hits.push([(c3[f.ua] - f.umin) * f.sx, (f.vmax - c3[f.va]) * f.sy, rr]);
  }
  if (!hits.length) return false;
  const layer = (ctx, style, scale, dx, dy, minR = 0, grow = 0) => {
    ctx.fillStyle = style;
    ctx.beginPath();
    for (const [x, y, r] of hits) {
      if (r < minR) continue;
      const rr = r * scale + grow;
      ctx.moveTo(x + dx * r + rr, y + dy * r);
      ctx.arc(x + dx * r, y + dy * r, rr, 0, TAU);
    }
    ctx.fill();
  };
  // coverage mask with the exact shape, color slightly larger (see PAINT_FRAGMENT)
  if (mask) layer(f.mctx, '#fff', 1, 0, 0);
  const ctx = f.ctx;
  layer(ctx, rgbStr(base, 0.72), 1, 0, 0, 0, 2);
  layer(ctx, rgbStr(base), 0.86, -0.04, -0.04);
  ctx.globalAlpha = 0.28;
  layer(ctx, rgbStr(mixWhite(base, 0.55)), 0.5, -0.22, -0.26, 3);
  ctx.globalAlpha = 0.55;
  layer(ctx, rgbStr(mixWhite(base, 0.85)), 0.16, -0.35, -0.4, 4);
  ctx.globalAlpha = 1;
  f.dirty = true;
  return true;
}

// Each splat circle is treated as a sphere of paint centered in the hit plane.
// Every face it intersects gets painted, so splats wrap over edges and corners.
// On walls the hit face is handed to the paint simulation below, so it runs down.
// mode: 'live' simulates the paint running down walls in real time, 'instant' runs
// that simulation to the end right away, 'static' skips it (cheap replays).
function paintSplat(sp, mode = 'live') {
  const t = perf.begin();
  perf.count(`paint.splats.${mode}`);
  paintSplatInner(sp, mode);
  perf.end('paint.splat', t);
}

function paintSplatInner(sp, mode) {
  const { circles, tint } = splatShape(sp.r, sp.s);
  const rgb = PALETTE_RGB[sp.c] || PALETTE_RGB[0];
  const reach = sp.r * 2;
  const hitFloor = sp.a === 1 && sp.sg > 0 && Math.abs(sp.p[1]) < 1e-3;

  for (const f of faces) {
    if (f.axis === sp.a && f.sign !== sp.sg) continue; // back sides
    if (Math.abs(sp.p[f.axis] - f.plane) > reach) continue;
    if (Math.max(f.umin - sp.p[f.ua], sp.p[f.ua] - f.umax) > reach) continue;
    if (Math.max(f.vmin - sp.p[f.va], sp.p[f.va] - f.vmax) > reach) continue;
    const k = f.shade * tint;
    const base = [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    const isHitFace = f.axis === sp.a && Math.abs(f.plane - sp.p[sp.a]) < 1e-3 &&
      sp.p[f.ua] >= f.umin && sp.p[f.ua] <= f.umax && sp.p[f.va] >= f.vmin && sp.p[f.va] <= f.vmax;
    if (mode !== 'static' && (isHitFace || (hitFloor && f.floor))) {
      // Flung droplets are drawn as they are; the core of the splat is rendered on the
      // GPU (see js/paintflow.js) and runs down if it hit a wall. A floor splat's
      // overlay spans neighbouring floor tiles, which only get the color for footprints.
      const drops = circles.filter(c => c[2] < sp.r * 0.18), core = circles.filter(c => c[2] >= sp.r * 0.18);
      paintCircles(f, sp, drops, base);
      if (isHitFace) startFlow(f, sp, core, base, mode === 'instant');
      else paintCircles(f, sp, core, base, false);
      continue;
    }
    paintCircles(f, sp, circles, base);
  }
}

// ---------------------------------------------------------------- Running paint
// Paint on walls runs down: see js/paintflow.js for the GPU simulation. Here the core
// of a wall splat is handed to it, and settled flows are baked back into the wall's
// paint canvas (bakeInto below redraws them on the CPU with the same lighting).

const paintFlow = createPaintFlow(renderer, scene);

function startFlow(f, sp, core, base, instant) {
  const t1 = (sp.a + 1) % 3;
  const uIsT1 = f.ua === t1;
  const pu = sp.p[f.ua], pv = sp.p[f.va], r = sp.r;
  const blobs = core.map(([cx, cy, rad]) => [pu + (uIsT1 ? cx : cy), pv + (uIsT1 ? cy : cx), rad]);
  const runs = f.axis !== 1; // only walls drip
  // Floor tiles are one continuous surface, so the overlay may span several of them.
  const lo = f.floor ? { u: -LEVEL.half, v: -LEVEL.half } : { u: f.umin, v: f.vmin };
  const hi = f.floor ? { u: LEVEL.half, v: LEVEL.half } : { u: f.umax, v: f.vmax };
  const u0 = Math.max(lo.u, pu - 1.3 * r), u1 = Math.min(hi.u, pu + 1.3 * r);
  const v1 = Math.min(hi.v, pv + (runs ? 1.2 : 1.3) * r);
  const v0 = Math.max(lo.v, runs ? pv - 1.2 * r - 2.6 : pv - 1.3 * r);
  if (u1 - u0 < 0.1 || v1 - v0 < 0.1) { paintCircles(f, sp, core, base); return; }
  // Floors: also put the color into the canvas (not the edge mask, so it stays
  // invisible) so footprints pick up fresh paint before it gets baked.
  if (!runs) paintCircles(f, sp, core, base, false);
  const color = new THREE.Color().setRGB(base[0] / 255, base[1] / 255, base[2] / 255, THREE.SRGBColorSpace);
  const fl = paintFlow.add({ face: f, u0, u1, v0, v1, blobs, color, seed: sp.s, instant, flow: runs });
  fl.base = base;
  if (instant) {
    bakeFlow(fl, paintFlow.readThickness(fl));
    paintFlow.remove(fl);
  }
}

// Draw a settled flow into the wall canvas (and puddles where it reached the floor).
function bakeFlow(fl, thick) {
  const t = perf.begin();
  perf.count('paint.bakes');
  bakeFlowInner(fl, thick);
  perf.end('paint.bake', t);
}

function bakeFlowInner(fl, thick) {
  const targets = fl.face.floor
    ? faces.filter(g => g.floor && g.umin < fl.u1 && fl.u0 < g.umax && g.vmin < fl.v1 && fl.v0 < g.vmax)
    : [fl.face];
  for (const g of targets) bakeInto(g, fl, thick);
  if (!fl.face.floor) addPuddles(fl, thick);
}

// Bakes a flow into one surface's paint canvas using the same lighting as the GPU
// shader (paintflow.js), so a splat doesn't visibly change when it gets baked. Slopes
// come straight from the simulation grid, so splats spanning floor tiles stay seamless.
const BAKE_LIGHT = (() => { const l = [0.35, 0.8, 0.5], n = Math.hypot(...l); return l.map(x => x / n); })();

function bakeInto(f, fl, thick) {
  const x0 = Math.max(0, Math.floor((fl.u0 - f.umin) * f.sx));
  const x1 = Math.min(f.canvas.width, Math.ceil((fl.u1 - f.umin) * f.sx));
  const y0 = Math.max(0, Math.floor((f.vmax - fl.v1) * f.sy));
  const y1 = Math.min(f.canvas.height, Math.ceil((f.vmax - fl.v0) * f.sy));
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) return;
  const at = (u, v) => {
    const sx = Math.min(fl.w - 1.001, Math.max(0, (u - fl.u0) * SIM_PPM - 0.5));
    const sy = Math.min(fl.h - 1.001, Math.max(0, (v - fl.v0) * SIM_PPM - 0.5));
    const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
    const i = iy * fl.w + ix;
    return (thick[i] * (1 - fx) + thick[i + 1] * fx) * (1 - fy) + (thick[i + fl.w] * (1 - fx) + thick[i + fl.w + 1] * fx) * fy;
  };
  const d = 2 / SIM_PPM; // same slope distance as the shader
  const L = BAKE_LIGHT;
  // world vectors of the face axes and its normal
  const U = [0, 0, 0], V = [0, 0, 0], N = [0, 0, 0];
  U[f.ua] = 1; V[f.va] = 1; N[f.axis] = f.sign;
  // Baked paint is seen from all sides, so the highlight uses the view along the normal.
  const H = [L[0] + N[0], L[1] + N[1], L[2] + N[2]];
  const hl = Math.hypot(...H); H[0] /= hl; H[1] /= hl; H[2] /= hl;

  const bgImg = f.ctx.getImageData(x0, y0, w, h), bgMask = f.mctx.getImageData(x0, y0, w, h);
  const bg = bgImg.data, bgm = bgMask.data;
  // the shader lights the color in linear space, so do the same here
  const lin = fl.base.map(c => Math.pow(c / 255, 2.2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const u = f.umin + (x0 + x + 0.5) / f.sx, v = f.vmax - (y0 + y + 0.5) / f.sy;
      if (u < fl.u0 || u > fl.u1 || v < fl.v0 || v > fl.v1) continue;
      // Edge mask as area coverage: texels on the edge are sampled 4x4 and store the
      // covered fraction, so the edge shader draws a smooth curve, not stair steps.
      const du = 0.5 / f.sx, dv = 0.5 / f.sy, TH = 0.045;
      const c00 = at(u - du, v - dv) > TH, c10 = at(u + du, v - dv) > TH;
      const c01 = at(u - du, v + dv) > TH, c11 = at(u + du, v + dv) > TH;
      let cover;
      if (c00 && c10 && c01 && c11) cover = 1;
      else if (!c00 && !c10 && !c01 && !c11) cover = 0;
      else {
        let n = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            if (at(u - du + (sx + 0.5) * du / 2, v - dv + (sy + 0.5) * dv / 2) > TH) n++;
          }
        }
        cover = n / 16;
      }
      const m = cover * 255;
      if (m > bgm[o]) bgm[o] = bgm[o + 1] = bgm[o + 2] = m;
      const t = at(u, v);
      if (t < 0.01 && cover === 0) continue;
      const hx = at(u + d, v) - at(u - d, v), hy = at(u, v + d) - at(u, v - d);
      let nx = -hx * 1.6 * U[0] - hy * 1.6 * V[0] + N[0];
      let ny = -hx * 1.6 * U[1] - hy * 1.6 * V[1] + N[1];
      let nz = -hx * 1.6 * U[2] - hy * 1.6 * V[2] + N[2];
      const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      const diff = 0.7 + 0.38 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      // baked highlights can't follow the view, so keep them to a subtle sheen
      const spec = Math.pow(Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]), 70) * 0.3;
      const s = Math.min(1, Math.max(0, t / 0.9));
      const rim = 1 - 0.16 * s * s * (3 - 2 * s);
      // color reaches a little beyond the mask edge (no light fringe)
      const a = cover > 0 ? 1 : Math.min(1, (t - 0.01) / 0.02);
      for (let c = 0; c < 3; c++) {
        const col = 255 * Math.pow(Math.min(1, lin[c] * diff * rim + spec), 1 / 2.2);
        bg[o + c] = bg[o + c] * (1 - a) + col * a;
      }
    }
  }
  f.ctx.putImageData(bgImg, x0, y0);
  f.mctx.putImageData(bgMask, x0, y0);
  f.dirty = true;
}

// Puddles below drips that reached the bottom of the wall.
function addPuddles(fl, thick) {
  const f = fl.face;
  if (f.axis === 1 || fl.v0 > f.vmin + 1e-3) return;
  for (let sx = 0; sx < fl.w; sx += 3) {
    const t = Math.max(thick[sx], thick[sx + 1] || 0, thick[sx + 2] || 0);
    if (t < 0.08) continue;
    const p = [0, 0, 0];
    p[f.axis] = f.plane + f.sign * 0.08;
    p[f.ua] = fl.u0 + (sx + 1.5) / SIM_PPM;
    p[f.va] = f.vmin;
    const floor = floorFaceAt(p[0], p[1], p[2]);
    if (!floor) continue;
    const px = (p[floor.ua] - floor.umin) * floor.sx, py = (floor.vmax - p[floor.va]) * floor.sy;
    const r = 2 + t * 4;
    floor.ctx.fillStyle = rgbStr(fl.base, 0.9);
    floor.ctx.beginPath();
    floor.ctx.ellipse(px, py, r * 1.3 + 2, r + 2, 0, 0, TAU);
    floor.ctx.fill();
    floor.mctx.fillStyle = '#fff';
    floor.mctx.beginPath();
    floor.mctx.ellipse(px, py, r * 1.3, r, 0, 0, TAU);
    floor.mctx.fill();
    floor.dirty = true;
    sx += 6;
  }
}

// Upward facing surface under a point, if any.
function floorFaceAt(x, y, z) {
  for (const f of faces) {
    if (f.axis !== 1 || f.sign < 0 || Math.abs(f.plane - y) > 0.08) continue;
    if (x >= f.umin && x <= f.umax && z >= f.vmin && z <= f.vmax) return f;
  }
  return null;
}

// Paint color on the ground at a point, or null when it's still white.
function groundPaintAt(x, y, z) {
  const f = floorFaceAt(x, y, z);
  if (!f) return null;
  const px = Math.min(f.canvas.width - 1, Math.max(0, (x - f.umin) * f.sx | 0));
  const py = Math.min(f.canvas.height - 1, Math.max(0, (f.vmax - z) * f.sy | 0));
  const [r, g, b] = f.ctx.getImageData(px, py, 1, 1).data;
  return r > 238 && g > 238 && b > 238 ? null : [r, g, b];
}

function flushPaint() {
  for (const f of faces) {
    if (f.dirty) {
      f.tex.needsUpdate = true;
      f.mtex.needsUpdate = true;
      f.dirty = false;
      perf.count('paint.textureUploads', 2);
      perf.count('paint.uploadedPixels', f.canvas.width * f.canvas.height * 2);
    }
  }
}

// ---------------------------------------------------------------- Footprints
// Walking through paint loads your shoes with that color; the next steps leave
// fading prints behind, which also gives away where invisible players went.

const STRIDE = 0.75;          // meters between prints
const PRINTS_PER_DIP = 8;     // prints until the paint on your shoes is used up
const PRINT_LIFE = 15;        // seconds a print stays
const PRINT_FADE = 4;         // seconds of fading out at the end
const MAX_PRINTS = 400;

const footTexture = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(34, 44, 20, 32, 0.08, 0, TAU);   // ball of the foot
  ctx.ellipse(30, 100, 14, 19, 0, 0, TAU);     // heel
  ctx.fill();
  ctx.fillRect(22, 60, 22, 36);                 // arch
  for (const [x, y, r] of [[16, 10, 6], [27, 5, 6], [38, 5, 5.5], [48, 9, 5], [55, 17, 4.5]]) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); // toes
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
const footGeo = new THREE.PlaneGeometry(0.17, 0.34); // a bit larger than life so trails read from afar
const footprints = [];

function makeWalker() {
  return { dist: 0, side: 1, paint: null, left: 0 };
}

// Called every frame for each walker with its feet position and horizontal velocity.
function trackSteps(w, pos, vx, vz, dt) {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.5) return;
  w.dist += speed * dt;
  if (w.dist < STRIDE) return;
  w.dist = 0;
  w.side = -w.side;
  const heading = Math.atan2(-vx, -vz);
  // feet sit a little to the left and right of the walking line
  const ox = Math.cos(heading) * 0.13 * w.side, oz = -Math.sin(heading) * 0.13 * w.side;
  const x = pos.x + ox, z = pos.z + oz;
  const under = groundPaintAt(x, pos.y, z);
  if (under) { w.paint = under; w.left = PRINTS_PER_DIP; }
  if (w.left <= 0 || !w.paint) return;
  addFootprint(x, pos.y, z, heading, w.side, w.paint, w.left / PRINTS_PER_DIP);
  w.left--;
}

function addFootprint(x, y, z, heading, side, rgb, strength) {
  const mat = new THREE.MeshBasicMaterial({
    map: footTexture, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const mesh = new THREE.Mesh(footGeo, mat);
  mesh.rotation.order = 'YXZ';
  mesh.rotation.set(-Math.PI / 2, heading, 0);
  mesh.scale.x = side; // mirrored for the other foot
  mesh.position.set(x, y + 0.004, z);
  scene.add(mesh);
  const opacity = 0.45 + 0.55 * strength;
  mat.opacity = opacity;
  footprints.push({ mesh, opacity, age: 0 });
  while (footprints.length > MAX_PRINTS) removeFootprint(0);
}

function removeFootprint(i) {
  const fp = footprints[i];
  scene.remove(fp.mesh);
  fp.mesh.material.dispose();
  footprints.splice(i, 1);
}

function updateFootprints(dt) {
  for (let i = footprints.length - 1; i >= 0; i--) {
    const fp = footprints[i];
    fp.age += dt;
    if (fp.age >= PRINT_LIFE) { removeFootprint(i); continue; }
    fp.mesh.material.opacity = fp.opacity * Math.min(1, (PRINT_LIFE - fp.age) / PRINT_FADE);
  }
}

function clearFootprints() {
  while (footprints.length) removeFootprint(footprints.length - 1);
}

// ---------------------------------------------------------------- Materials & shared geometry

const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
// ?debug renders players in visible colors so they can be seen while developing.
const DEBUG = new URLSearchParams(location.search).has('debug');
const avatarMat = DEBUG ? new THREE.MeshNormalMaterial() : whiteMat;
// Hooks for testing from the browser console with ?debug.
if (DEBUG) window.splatter = { get me() { return me; }, avatars: () => avatars, paintSplat: sp => paintSplat(sp), trackSteps, makeWalker, flows: () => paintFlow.flows, updateFlows: dt => paintFlow.update(dt, bakeFlow), updateFootprints, fluid: () => fluid, spawnProjectile: (...a) => spawnProjectile(...a), viewer: () => viewer };
const colorMats = PALETTE.map(hex => new THREE.MeshBasicMaterial({ color: hex }));
const dotGeo = new THREE.SphereGeometry(1, 10, 8);

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
const myWalker = makeWalker();
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
  fluid.clear();
}

// ---------------------------------------------------------------- Avatars

function makeAvatar() {
  const ch = createCharacter({ bodyMat: avatarMat, gunShellMat: avatarMat, gunDarkMat: avatarMat });
  scene.add(ch.root);
  return {
    ch, group: ch.root, dead: false, dots: [], stepDist: 0, walker: makeWalker(),
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

  // limp body: the ragdoll moves the bones instead of the animations
  if (av.dead && av.ragdoll?.active) {
    const t = perf.begin();
    av.ragdoll.step(dt);
    av.ragdoll.apply();
    perf.end('ragdoll', t);
    return;
  }

  let twist = 0;
  if (!av.dead) {
    const airborne = pos.y - groundHeight(pos.x, pos.z, pos.y + 0.3) > 0.3;
    twist = locomotion(av.ch, av.vel, av.yaw, airborne);
    const speed = Math.hypot(av.vel.x, av.vel.z);
    if (!airborne) trackSteps(av.walker, pos, av.vel.x, av.vel.z, dt);
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

// Splatted players go limp: a ragdoll starts from the current pose and gets pushed
// where the last shot hit them (see js/ragdoll.js).
function killAvatar(av) {
  av.dead = true;
  av.ragdoll ||= createRagdoll(av.ch);
  av.ragdoll.start(av.vel);
  const h = av.lastHit;
  if (h && performance.now() - h.time < 1000) {
    av.ragdoll.hit(h.point, h.dir, 8);
  } else {
    const a = Math.random() * Math.PI * 2;
    av.ragdoll.hit(av.group.position.clone().setY(av.group.position.y + 1.2), new THREE.Vector3(Math.cos(a), 0.2, Math.sin(a)), 5);
  }
}

function reviveAvatar(av, p) {
  clearAvatarPaint(av);
  av.dead = false;
  av.ragdoll?.stop();
  av.lastHit = null;
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

// Liquid paint in the air (projectiles and impact splashes), see js/fluid.js.
const fluid = createFluid(renderer);
const paintColors = PALETTE.map(hex => new THREE.Color(hex));

function spawnProjectile(key, o, v, color, offset) {
  projectiles.set(key, { color: paintColors[color] || paintColors[0], p: o.slice(), v: v.slice(), born: performance.now(), offset });
}

function removeProjectile(key) {
  projectiles.delete(key);
}

const _head = new THREE.Vector3(), _dir = new THREE.Vector3();

function updateProjectiles(dt) {
  const now = performance.now();
  for (const [key, pr] of projectiles) {
    const { hit } = stepProjectile(pr, dt);
    // The server decides impacts; locally we only hide blobs that hit a wall.
    if (hit || now - pr.born > C.BLOB_LIFETIME * 1000) { removeProjectile(key); continue; }
    _head.set(...pr.p);
    if (pr.offset) {
      // Start the blob at the gun muzzle and blend onto the true aim line.
      const k = Math.max(0, 1 - (now - pr.born) / 120);
      _head.addScaledVector(pr.offset, k);
    }
    // A gooey drop with a short tail that merges into it.
    _dir.set(...pr.v).normalize();
    fluid.blob(_head.clone(), 0.2, pr.color);
    fluid.blob(_head.clone().addScaledVector(_dir, -0.13), 0.15, pr.color);
    fluid.blob(_head.clone().addScaledVector(_dir, -0.25), 0.1, pr.color);
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

// Identifies this browser, so the server keeps one player per browser across tabs
// and refreshes.
const clientId = (() => {
  try {
    let id = localStorage.getItem('splatter-id');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
      localStorage.setItem('splatter-id', id);
    }
    return id;
  } catch {
    return null;
  }
})();
let closeMessage = '';

function connect(name, color) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  leaving = false;
  closeMessage = '';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => send({ t: 'join', name, color, cid: clientId });
  ws.onmessage = e => {
    const t = performance.now();
    const m = JSON.parse(e.data);
    handle(m);
    perf.message(m.t, e.data.length, performance.now() - t);
  };
  ws.onclose = () => {
    clearMatch();
    showScreen('menu');
    $('play').disabled = false;
    $('menuError').textContent = closeMessage || (leaving ? '' : 'Disconnected from server.');
  };
  ws.onerror = () => { $('menuError').textContent = 'Could not reach the server.'; };
}

function leave() {
  if (screen === 'game') perf.finish('left the match');
  leaving = true;
  if (ws) ws.close();
}
// Close the connection right away when the page goes (refresh, tab closed), so the
// player leaves the lobby immediately instead of lingering.
window.addEventListener('pagehide', () => {
  if (screen === 'game') perf.flushOnExit('left the page');
  if (ws) { leaving = true; ws.close(); }
});

function enterGame(m) {
  perf.reset();
  perf.meta = { name: roster.get(me.id)?.name ?? $('name').value, joinedPhase: m.round.state };
  clearMatch();
  for (const p of m.players) addRoster(p);
  clearPaint();
  // Replaying a running match: the newest wall splats get their drips, older ones
  // are drawn without the simulation to keep joining fast.
  m.splats.forEach((sp, i) => paintSplat(sp, i >= m.splats.length - 60 ? 'instant' : 'static'));
  setRound(m.round);
  me.alive = false;
  me.killedBy = null;
  me.hp = C.MAX_HP;
  showScreen('game');
  $('roundEnd').hidden = true;
  refreshStats();
  if (m.round.state === 'loading') {
    // Tell the server once the level is on screen. Background tabs don't render
    // frames, so fall back to a timer.
    let sent = false;
    const ready = () => { if (!sent) { sent = true; send({ t: 'ready' }); } };
    requestAnimationFrame(() => requestAnimationFrame(ready));
    setTimeout(ready, 1000);
  }
}

function handle(m) {
  switch (m.t) {
    case 'kicked':
      closeMessage = 'You joined from another tab or window.';
      leaving = true;
      break;
    case 'full':
      closeMessage = `This game is full (${m.max} players).`;
      leaving = true;
      break;
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
      refreshStats();
      break;
    case 'leave':
      if (screen === 'game' && roster.has(m.id)) feed(`${nameTag(m.id)} left`);
      removeRoster(m.id);
      refreshStats();
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
    case 'splat': {
      removeProjectile(m.id);
      paintSplat(m);
      sfx.splat(m.p);
      const n = [0, 0, 0];
      n[m.a] = m.sg;
      // kills leave a big splat, and a bigger burst
      const big = m.id === 0;
      fluid.splash(m.p, n, paintColors[m.c], big ? { count: 28, speed: 4.2, size: 0.12, life: 0.8 } : {});
      break;
    }
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
        const at = hitAv.group.position.clone().add(new THREE.Vector3(...m.off));
        if (m.dir) hitAv.lastHit = { point: at.clone(), dir: new THREE.Vector3(...m.dir), time: performance.now() };
        const out = [m.off[0], 0.3, m.off[2]];
        fluid.splash(at.toArray(), out, paintColors[m.c], { count: 10, speed: 2.6, size: 0.08, life: 0.5 });
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
      refreshStats();
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
      if (m.round.state === 'ended') {
        showRoundEnd(m.scores);
        perf.finish('match ended');
      }
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

  // Bot settings: the leader edits them, everyone else sees them.
  const st = lobbyState.settings || { bots: false, botCount: 0, maxPlayers: 10 };
  const bots = st.bots ? Math.max(0, Math.min(st.botCount, st.maxPlayers - n)) : 0;
  document.querySelector('.bot-settings').classList.toggle('readonly', !isLeader);
  $('botsEnabled').checked = st.bots;
  $('botsEnabled').disabled = !isLeader;
  $('botCount').textContent = st.botCount;
  $('botsMinus').disabled = !isLeader || !st.bots || st.botCount <= 1;
  $('botsPlus').disabled = !isLeader || !st.bots || st.botCount >= st.maxPlayers - 1;
  $('botSummary').textContent = st.bots
    ? `${n} player${n === 1 ? '' : 's'} + ${bots} bot${bots === 1 ? '' : 's'} = ${n + bots} of ${st.maxPlayers}` +
      (bots < st.botCount ? ' (bots make room for players)' : '')
    : `${n} player${n === 1 ? '' : 's'}, bots are off (max ${st.maxPlayers})`;
  lobby.setPlayers(players, leader, me.id);
}

function sendSettings(change) {
  const st = lobbyState.settings;
  if (!st) return;
  // apply right away so quick repeated clicks add up; the server confirms
  Object.assign(st, change);
  st.botCount = Math.min(st.maxPlayers - 1, Math.max(1, st.botCount));
  send({ t: 'settings', bots: st.bots, botCount: st.botCount });
  renderLobby();
}
$('botsEnabled').addEventListener('change', e => sendSettings({ bots: e.target.checked }));
$('botsMinus').addEventListener('click', () => sendSettings({ botCount: lobbyState.settings.botCount - 1 }));
$('botsPlus').addEventListener('click', () => sendSettings({ botCount: lobbyState.settings.botCount + 1 }));

$('startMatch').addEventListener('click', () => {
  initAudio();
  lockPointer();
  send({ t: 'start' });
});
// The animation viewer is a development tool: only offered with ?debug.
$('openViewer').hidden = !DEBUG;
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

// Scores changed: update the stats window if it's open (Tab or while respawning).
function refreshStats() {
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

// Sections of a game frame, timed when profiling (?profile).
function timed(name, fn) {
  const t = perf.begin();
  fn();
  perf.end(name, t);
}

function gameFrame(now, dt) {
  const frame = perf.frameStart(now);
  renderer.info.reset();
  const tp = perf.begin();
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
    if (me.onGround) trackSteps(myWalker, { x: me.p[0], y: me.p[1], z: me.p[2] }, me.v[0], me.v[2], dt);
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

  perf.end('player', tp);

  const k = 1 - Math.exp(-15 * dt);
  timed('avatars', () => { for (const av of avatars.values()) updateAvatar(av, dt, k); });
  timed('projectiles', () => updateProjectiles(dt));
  timed('paintflow', () => paintFlow.update(dt, bakeFlow));
  timed('footprints', () => updateFootprints(dt));
  timed('hud', () => updateHud(now, dt));
  timed('flushPaint', flushPaint);
  timed('fluid.update', () => fluid.update(dt));
  timed('render', () => fluid.render(scene, camera));
  if (perf.enabled) {
    perf.frameEnd(frame, {
      overlays: paintFlow.flows.length, liveFlows: paintFlow.flows.filter(f => f.live).length,
      drops: fluid.drops.length, footprints: footprints.length, avatars: avatars.size,
      calls: renderer.info.render.calls, textures: renderer.info.memory.textures,
    });
  }
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (screen === 'game') gameFrame(now, dt);
  else if (screen === 'lobby') lobby.render(dt);
  else if (screen === 'viewer') viewer.render(dt);
});

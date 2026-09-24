// GPU simulation of paint running down walls.
//
// Every fresh splat on a wall gets a region in a shared simulation texture (the live
// atlas) holding the paint thickness (R) and two flags (G = wet + 2 * blob): whether a
// texel has been wetted and whether it belonged to the original blob. A fragment
// shader advances all running splats at once, one draw call per step: paint above
// what a texel can hold slides down, preferring wet and thick texels, and only breaks
// out onto dry wall where enough has piled up. That makes the paint sag inside the
// blob and run down in a few rivulets with drops at their tips.
//
// When a splat has settled, its thickness moves to a second atlas (settled), freeing
// its place in the live one. All splats are drawn by one instanced quad just in front
// of their surface, with a crisp edge and lighting from the thickness, including a view
// dependent wet highlight. When the settled atlas is full, the oldest splat is baked
// into its surface's paint (js/surfaces.js), also on the GPU: nothing is read back,
// except the bottom row of splats that ran down to the floor (for the puddles).

import * as THREE from 'three';
import { RECT_VERTEX } from './blit.js';
import { perf } from './perf.js';

export const SIM_PPM = 96;         // simulation texels per meter
const STEP = 1 / 90;               // seconds per simulation step (at most one texel of travel)
const LIVE_STEPS = 540;            // steps a flow is simulated (6 s); even, see runInstant
const RATE = 0.5;                  // share of the excess paint that moves per step
const TACKY = 0.997;               // paint slowly gets tacky: rate factor per step
const UNIT_W = 216, UNIT_H = 224;  // atlas slot size in texels; tall flows take two stacked units
const MAX_BLOBS = 16;

const cellCode = `
  uniform vec2 atlas;     // atlas size in texels
  flat varying vec4 vSlot; // x, y, w, h in texels
  // Texel c of the flow (local coordinates): thickness, wet, blob, and -1 in w for
  // the walls of the region. Below the region paint leaves.
  vec4 cell(vec2 c) {
    if (c.x < 0.0 || c.x > vSlot.z - 1.0 || c.y > vSlot.w - 1.0) return vec4(0.0, 1.0, 0.0, -1.0);
    if (c.y < 0.0) return vec4(0.0, 1.0, 0.0, 1.0);
    vec2 s = texture2D(src, (vSlot.xy + c + 0.5) / atlas).rg;
    float blob = s.g > 1.5 ? 1.0 : 0.0;
    return vec4(s.r, s.g - 2.0 * blob, blob, 1.0);
  }`;

const STEP_VERTEX = `
  attribute vec4 slot;
  attribute vec4 params; // seed, rate at the start, step it started at
  uniform vec2 atlas;
  flat varying vec4 vSlot;
  flat varying vec4 vParams;
  void main() {
    vSlot = slot;
    vParams = params;
    gl_Position = vec4((slot.xy + position.xy * slot.zw) / atlas * 2.0 - 1.0, 0.0, 1.0);
  }`;

const STEP_FRAGMENT = `
  uniform sampler2D src;
  uniform float stepNow;
  flat varying vec4 vParams;
  float seed, rate;
  ${cellCode}

  float hash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030) + seed);
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
  }
  float colNoise(float x) { return hash(vec2(floor(x), 7.31)); }
  // smooth value noise, so the blob sags evenly instead of in fine streaks
  float smoothNoise(vec2 c) {
    vec2 g = c / 14.0, i = floor(g), f = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
  }
  float stickAt(vec2 c, float blob) {
    return blob > 0.5 ? 0.12 + 0.1 * smoothNoise(c) : 0.13 + 0.1 * smoothNoise(c + 31.0);
  }
  // Dry wall only lets paint through in a few narrow strips; those become the drips.
  float pinAt(vec2 c) {
    float cn = colNoise(c.x / 14.0);
    float mid = abs(mod(c.x, 14.0) - 7.0 - floor(cn * 5.0 - 2.0)); // a narrow slot, offset per strip
    return cn > 0.82 && mid < 1.5 ? 0.03 + 0.05 * hash(c) : (cn > 0.82 ? 0.3 : 1e3);
  }
  // slowly varying sideways bias, so drips wander a little instead of running straight
  float roughAt(vec2 c) { return (smoothNoise(c * vec2(0.35, 0.12) + 17.0) * 2.0 - 1.0) * 0.95; }

  // Weight with which source texel s (thickness excess ex) sends paint to s + (dx, -1).
  float weightTo(vec2 s, float dx, float ex) {
    vec2 t = s + vec2(dx, -1.0);
    vec4 T = cell(t);
    if (T.a < 0.0) return 0.0;
    bool open = T.g > 0.5 || ex > pinAt(t);
    if (!open) return 0.0;
    float r = roughAt(s);
    float base = dx == 0.0 ? 1.0 : 0.3 * (1.0 + (dx < 0.0 ? r : -r));
    return base * (1.0 + 6.0 * T.r);
  }
  // Paint leaving texel s this step and its split to the three texels below.
  vec4 outflow(vec2 s) {
    vec4 S = cell(s);
    if (S.a < 0.0) return vec4(0.0);
    float ex = S.r - stickAt(s, S.b);
    if (ex <= 0.002) return vec4(0.0);
    float wl = weightTo(s, -1.0, ex), wb = weightTo(s, 0.0, ex), wr = weightTo(s, 1.0, ex);
    float tot = wl + wb + wr;
    if (tot <= 0.0) return vec4(0.0);
    // Thick paint runs, a thin film barely moves (film flow grows with thickness),
    // so paint piles up at the front of a drip into a round drop.
    float m = ex * rate * clamp(ex * 2.6, 0.08, 1.0);
    return vec4(m, wl / tot, wb / tot, wr / tot);
  }

  void main() {
    seed = vParams.x;
    rate = vParams.y * pow(${TACKY}, stepNow - vParams.z);
    vec2 c = floor(gl_FragCoord.xy) - vSlot.xy;
    vec4 me = cell(c);
    float h = me.r - outflow(c).x;
    float gain = 0.0;
    // the three texels above that can send paint here
    vec4 o = outflow(c + vec2(1.0, 1.0));  gain += o.x * o.y; // its down-left is me
    o = outflow(c + vec2(0.0, 1.0));       gain += o.x * o.z;
    o = outflow(c + vec2(-1.0, 1.0));      gain += o.x * o.w; // its down-right is me
    h += gain;
    // Surface tension: wet paint evens out sideways, which feeds the drips and keeps
    // them a few texels wide. Pairwise exchange, so no paint is created or lost.
    vec4 L = cell(c - vec2(1.0, 0.0)), R = cell(c + vec2(1.0, 0.0));
    if (me.g > 0.5) {
      if (L.a >= 0.0 && L.g > 0.5) h += 0.08 * (L.r - me.r);
      if (R.a >= 0.0 && R.g > 0.5) h += 0.08 * (R.r - me.r);
    }
    float wet = max(me.g, gain > 0.0005 ? 1.0 : 0.0);
    gl_FragColor = vec4(h, wet + 2.0 * me.b, 0.0, 1.0);
  }`;

// Initial thickness of a new flow: a dome per blob. vP is the local texel position.
const INIT_FRAGMENT = `
  uniform vec3 blobs[${MAX_BLOBS}]; // x, y, radius in texels
  uniform int count;
  varying vec2 vP;
  void main() {
    float t = 0.0;
    bool inside = false;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
      if (i >= count) break;
      vec3 b = blobs[i];
      vec2 d = vP - b.xy;
      float d2 = dot(d, d) / (b.z * b.z);
      if (d2 >= 1.0) continue;
      t = max(t, 0.75 * sqrt(1.0 - d2));
      inside = true;
    }
    gl_FragColor = vec4(t, inside ? 3.0 : 0.0, 0.0, 1.0);
  }`;

// Copies the thickness of a flow from one atlas to another (vP: local texel position),
// multiplied by scale.
const COPY_FRAGMENT = `
  uniform sampler2D src;
  uniform vec2 srcSize;
  uniform vec2 srcOrigin;
  uniform float scale;
  varying vec2 vP;
  void main() {
    gl_FragColor = vec4(vec3(texture2D(src, (srcOrigin + vP) / srcSize).r * scale), 1.0);
  }`;

const DRAW_VERTEX = `
  attribute vec3 origin;
  attribute vec3 axU;   // face axis times the region's width
  attribute vec3 axV;
  attribute vec3 nrm;
  attribute vec3 col;
  attribute vec4 slot;
  attribute float which; // 0: live atlas, 1: settled atlas
  varying vec2 vUv;
  varying vec3 vWorld;
  flat varying vec4 vSlot;
  flat varying vec3 vCol, vU, vV, vN;
  flat varying float vWhich;
  void main() {
    vUv = position.xy;
    vSlot = slot; vCol = col; vWhich = which;
    vU = normalize(axU); vV = normalize(axV); vN = nrm;
    vec3 w = origin + position.x * axU + position.y * axV + nrm * 0.002;
    vWorld = w;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`;

const DRAW_FRAGMENT = `
  uniform sampler2D live;
  uniform sampler2D settled;
  uniform vec2 liveSize;
  uniform vec2 settledSize;
  varying vec2 vUv;
  varying vec3 vWorld;
  flat varying vec4 vSlot;
  flat varying vec3 vCol, vU, vV, vN;
  flat varying float vWhich;
  // thickness at local texel position p (clamped to the flow like a texture's edge)
  float thick(vec2 p) {
    vec2 q = vSlot.xy + clamp(p, vec2(0.5), vSlot.zw - 0.5);
    return vWhich > 0.5 ? texture2D(settled, q / settledSize).r : texture2D(live, q / liveSize).r;
  }
  void main() {
    vec2 p = vUv * vSlot.zw;
    float h = thick(p);
    float w = max(fwidth(h) * 0.8, 0.002);
    float a = smoothstep(0.045 - w, 0.045 + w, h);
    if (a <= 0.001) discard;
    float hx = thick(p + vec2(2.0, 0.0)) - thick(p - vec2(2.0, 0.0));
    float hy = thick(p + vec2(0.0, 2.0)) - thick(p - vec2(0.0, 2.0));
    vec3 n = normalize(-hx * 1.6 * vU - hy * 1.6 * vV + vN);
    vec3 L = normalize(vec3(0.35, 0.8, 0.5));
    vec3 V = normalize(cameraPosition - vWorld);
    float diff = 0.7 + 0.38 * max(dot(n, L), 0.0);
    float spec = pow(max(dot(n, normalize(L + V)), 0.0), 70.0) * 0.9;
    float rim = 1.0 - 0.16 * smoothstep(0.0, 0.9, h);
    vec3 c = vCol * diff * rim + spec;
    gl_FragColor = vec4(c, a);
    #include <colorspace_fragment>
  }`;

// Bakes a flow into a surface's paint with the same lighting as DRAW_FRAGMENT, so a
// splat doesn't visibly change when it gets baked. vP is the position on the face in
// meters. Baked paint is seen from all sides, so the highlight uses the view along the
// normal and stays a subtle sheen.
const BAKE_FRAGMENT = `
  uniform sampler2D src;
  uniform vec2 srcSize;
  uniform vec4 slot;
  uniform vec4 region;  // u0, v0 of the flow; texel size of the face / 2 in zw
  uniform vec3 lin;     // paint color, linear
  uniform vec3 U, V, N, H;
  uniform float pass;   // 0: color, 1: coverage mask
  varying vec2 vP;
  float at(vec2 uv) {
    vec2 s = clamp((uv - region.xy) * ${SIM_PPM.toFixed(1)} - 0.5, vec2(0.0), slot.zw - 1.001);
    return texture2D(src, (slot.xy + s + 0.5) / srcSize).r;
  }
  // Edge mask as area coverage: texels on the edge are sampled 4x4 and store the
  // covered fraction, so the edge shader draws a smooth curve, not stair steps.
  const float TH = 0.045;
  float coverage(vec2 p) {
    vec2 d = region.zw;
    bool c00 = at(p - d) > TH, c10 = at(p + vec2(d.x, -d.y)) > TH;
    bool c01 = at(p + vec2(-d.x, d.y)) > TH, c11 = at(p + d) > TH;
    if (c00 && c10 && c01 && c11) return 1.0;
    if (!c00 && !c10 && !c01 && !c11) return 0.0;
    float n = 0.0;
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
      if (at(p - d + (vec2(x, y) + 0.5) * d / 2.0) > TH) n += 1.0;
    }
    return n / 16.0;
  }
  void main() {
    float cover = coverage(vP);
    if (pass > 0.5) {
      if (cover <= 0.0) discard;
      gl_FragColor = vec4(cover, 0.0, 0.0, 1.0);
      return;
    }
    // The color covers the shape grown by a texel: filtering doesn't blend white into
    // the border, and where it overlaps other paint the border stays smooth.
    float grown = cover;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      grown = max(grown, coverage(vP + vec2(x, y) * 2.0 * region.zw));
    }
    float t = at(vP);
    if (t < 0.01 && grown <= 0.0) discard;
    float e = 2.0 / ${SIM_PPM.toFixed(1)}; // same slope distance as the draw shader
    float hx = at(vP + vec2(e, 0.0)) - at(vP - vec2(e, 0.0));
    float hy = at(vP + vec2(0.0, e)) - at(vP - vec2(0.0, e));
    vec3 n = normalize(-hx * 1.6 * U - hy * 1.6 * V + N);
    vec3 L = normalize(vec3(0.35, 0.8, 0.5));
    float diff = 0.7 + 0.38 * max(dot(n, L), 0.0);
    float spec = pow(max(dot(n, H), 0.0), 70.0) * 0.3;
    float s = clamp(t / 0.9, 0.0, 1.0);
    float rim = 1.0 - 0.16 * s * s * (3.0 - 2.0 * s);
    float a = max(grown, min(1.0, (t - 0.01) / 0.02));
    gl_FragColor = vec4(min(vec3(1.0), lin * diff * rim + spec), a);
  }`;

// Slots of UNIT_W x UNIT_H texels in an atlas. Flows up to UNIT_H tall take one unit,
// taller ones two stacked units (rows 2k and 2k + 1). Short flows prefer units whose
// partner is taken, so pairs stay free for tall ones.
class Slots {
  constructor(width, height) {
    this.cols = Math.floor(width / UNIT_W);
    this.rows = Math.floor(height / UNIT_H);
    this.used = new Uint8Array(this.cols * this.rows);
  }
  alloc(h) {
    const { cols, rows, used } = this;
    if (h > UNIT_H) {
      for (let r = 0; r + 1 < rows; r += 2) {
        for (let c = 0; c < cols; c++) {
          const a = r * cols + c, b = a + cols;
          if (!used[a] && !used[b]) { used[a] = used[b] = 1; return { x: c * UNIT_W, y: r * UNIT_H, units: [a, b] }; }
        }
      }
      return null;
    }
    let spare = -1;
    for (let i = 0; i < used.length; i++) {
      if (used[i]) continue;
      const r = Math.floor(i / cols), partner = (r ^ 1) < rows ? i + ((r ^ 1) - r) * cols : -1;
      if (partner < 0 || used[partner]) { spare = i; break; }
      if (spare < 0) spare = i;
    }
    if (spare < 0) return null;
    used[spare] = 1;
    return { x: (spare % cols) * UNIT_W, y: Math.floor(spare / cols) * UNIT_H, units: [spare] };
  }
  free(slot) { for (const u of slot.units) this.used[u] = 0; }
  clear() { this.used.fill(0); }
}

export function createPaintFlow(renderer, scene, blit, surfaces, { onBottomRow }) {
  const maxTex = renderer.capabilities.maxTextureSize;
  const W = Math.min(4096, maxTex);
  const liveSize = new THREE.Vector2(W, Math.min(2048, maxTex));
  const settledSize = new THREE.Vector2(W, Math.min(4096, maxTex));
  const atlasTarget = (size, format) => new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType, format, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  // live flows ping-pong between two atlases; settled ones only need their thickness
  let src = atlasTarget(liveSize, THREE.RGFormat), dst = atlasTarget(liveSize, THREE.RGFormat);
  const settled = atlasTarget(settledSize, THREE.RedFormat);
  const liveSlots = new Slots(liveSize.x, liveSize.y), settledSlots = new Slots(settledSize.x, settledSize.y);
  const capacity = liveSlots.used.length + settledSlots.used.length;
  // Bottom rows of flows are copied here (thickness / ROW_SCALE in 8 bits) to be read
  // back for the puddles.
  const ROW_SCALE = 4;
  const rowTarget = new THREE.WebGLRenderTarget(UNIT_W, 1, { depthBuffer: false, generateMipmaps: false });
  const gl = renderer.getContext();

  const quadPositions = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3);
  const instanced = (attrs) => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', quadPositions);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [name, size] of attrs) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size));
    g.instanceCount = 0;
    return g;
  };

  const stepGeo = instanced([['slot', 4], ['params', 4]]);
  const stepMat = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, atlas: { value: liveSize }, stepNow: { value: 0 } },
    vertexShader: STEP_VERTEX, fragmentShader: STEP_FRAGMENT, depthTest: false, depthWrite: false,
  });
  const rectMat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
    uniforms: { ...uniforms, rect: { value: new THREE.Vector4() }, area: { value: new THREE.Vector4() } },
    vertexShader: RECT_VERTEX, fragmentShader, depthTest: false, depthWrite: false,
  });
  const initMat = rectMat(INIT_FRAGMENT, { blobs: { value: new Float32Array(MAX_BLOBS * 3) }, count: { value: 0 } });
  const copyMat = rectMat(COPY_FRAGMENT, { src: { value: null }, srcSize: { value: new THREE.Vector2() }, srcOrigin: { value: new THREE.Vector2() }, scale: { value: 1 } });
  const bakeUniforms = () => ({
    src: { value: null }, srcSize: { value: new THREE.Vector2() }, slot: { value: new THREE.Vector4() },
    region: { value: new THREE.Vector4() }, lin: { value: new THREE.Vector3() },
    U: { value: new THREE.Vector3() }, V: { value: new THREE.Vector3() }, N: { value: new THREE.Vector3() }, H: { value: new THREE.Vector3() },
  });
  const bakeColor = rectMat(BAKE_FRAGMENT, { ...bakeUniforms(), pass: { value: 0 } });
  bakeColor.transparent = true;
  const bakeMask = rectMat(BAKE_FRAGMENT, { ...bakeUniforms(), pass: { value: 1 } });
  Object.assign(bakeMask, { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });

  const drawGeo = instanced([['origin', 3], ['axU', 3], ['axV', 3], ['nrm', 3], ['col', 3], ['slot', 4], ['which', 1]]);
  const drawMat = new THREE.ShaderMaterial({
    uniforms: { live: { value: src.texture }, settled: { value: settled.texture }, liveSize: { value: liveSize }, settledSize: { value: settledSize } },
    vertexShader: DRAW_VERTEX, fragmentShader: DRAW_FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  const overlay = new THREE.Mesh(drawGeo, drawMat);
  overlay.frustumCulled = false;
  overlay.renderOrder = 1; // over footprints
  scene.add(overlay);

  // Compile the shaders now instead of on the first splat (a hitch of up to 100 ms).
  // The rectangles are empty, so nothing is drawn.
  for (const m of [initMat, copyMat, bakeColor, bakeMask]) blit.draw(rowTarget, m);
  blit.draw(dst, stepMat, stepGeo);

  const flows = [];        // oldest first; drawn in this order
  let pendingInstant = [];
  let stepCount = 0, acc = 0;
  let liveDirty = true, drawDirty = true;

  function setRect(mat, atlasSize, slot, w, h) {
    mat.uniforms.rect.value.set(slot.x / atlasSize.x, slot.y / atlasSize.y, (slot.x + w) / atlasSize.x, (slot.y + h) / atlasSize.y);
    mat.uniforms.area.value.set(0, 0, w, h);
  }

  // region: { face, u0, u1, v0, v1 } in world meters on the face plane
  // blobs: [[u, v, radius]] in world meters, color: THREE.Color (linear), base: the same
  // color in sRGB 0..255 (for baking), seed: int, targets: faces the flow gets baked
  // into, bottomRow: report the bottom row when baked (puddles).
  // flow: false renders the splat the same way without letting it run (floors).
  function add({ face, u0, u1, v0, v1, blobs, color, base, seed, instant, flow = true, targets = [face], bottomRow = false }) {
    let w = Math.max(8, Math.round((u1 - u0) * SIM_PPM));
    let h = Math.max(8, Math.round((v1 - v0) * SIM_PPM));
    if (w > UNIT_W) { const cu = (u0 + u1) / 2; u0 = cu - UNIT_W / SIM_PPM / 2; u1 = cu + UNIT_W / SIM_PPM / 2; w = UNIT_W; }
    if (h > 2 * UNIT_H) { v0 = v1 - 2 * UNIT_H / SIM_PPM; h = 2 * UNIT_H; }

    const slots = flow ? liveSlots : settledSlots;
    let slot = slots.alloc(h);
    while (!slot) {
      if (flow) {
        if (pendingInstant.length) runInstant();
        else settle(flows.find(f => f.live));
      } else bakeOldest();
      slot = slots.alloc(h);
    }

    const blobArr = initMat.uniforms.blobs.value;
    const list = blobs.slice(0, MAX_BLOBS);
    list.forEach(([bu, bv, br], i) => blobArr.set([(bu - u0) * SIM_PPM, (bv - v0) * SIM_PPM, br * SIM_PPM], i * 3));
    initMat.uniforms.count.value = list.length;
    const atlasSize = flow ? liveSize : settledSize;
    setRect(initMat, atlasSize, slot, w, h);
    blit.draw(flow ? src : settled, initMat);

    const fl = {
      face, u0, u1, v0, v1, w, h, color, base, targets, bottomRow, slot,
      seed: (seed % 997) / 997, live: flow, startStep: stepCount,
    };
    flows.push(fl);
    if (flow) liveDirty = true;
    drawDirty = true;
    if (instant) {
      if (flow) pendingInstant.push(fl);
      else { bake(fl); remove(fl); }
    }
    return fl;
  }

  function writeStepInstances(list, startAtZero) {
    const slotA = stepGeo.attributes.slot, paramA = stepGeo.attributes.params;
    list.forEach((fl, i) => {
      slotA.array.set([fl.slot.x, fl.slot.y, fl.w, fl.h], i * 4);
      paramA.array.set([fl.seed, RATE, startAtZero ? 0 : fl.startStep, 0], i * 4);
    });
    slotA.needsUpdate = paramA.needsUpdate = true;
    stepGeo.instanceCount = list.length;
  }

  function step(now) {
    stepMat.uniforms.src.value = src.texture;
    stepMat.uniforms.stepNow.value = now;
    blit.draw(dst, stepMat, stepGeo);
    [src, dst] = [dst, src];
  }

  // Joining a running match: simulate the newest wall splats to the end right away
  // and bake them. Only these flows are stepped; any other live flow isn't written
  // in between, which is fine because the step count is even, so it ends up in the
  // atlas it started in.
  function runInstant() {
    const list = pendingInstant.filter(f => !f.removed);
    pendingInstant = [];
    if (list.length) {
      writeStepInstances(list, true);
      for (let i = 0; i < LIVE_STEPS; i++) step(i);
      for (const fl of list) { bake(fl); remove(fl); }
    }
    liveDirty = true;
  }

  // A flow stopped running: move its thickness to the settled atlas.
  function settle(fl) {
    let slot = settledSlots.alloc(fl.h);
    while (!slot) { bakeOldest(); slot = settledSlots.alloc(fl.h); }
    copyMat.uniforms.src.value = src.texture;
    copyMat.uniforms.srcSize.value.copy(liveSize);
    copyMat.uniforms.srcOrigin.value.set(fl.slot.x, fl.slot.y);
    setRect(copyMat, settledSize, slot, fl.w, fl.h);
    blit.draw(settled, copyMat);
    liveSlots.free(fl.slot);
    fl.slot = slot;
    fl.live = false;
    liveDirty = drawDirty = true;
  }

  function bakeOldest() {
    const fl = flows.find(f => !f.live);
    bake(fl);
    remove(fl);
  }

  // Draws a flow into the paint of the surfaces it covers (see BAKE_FRAGMENT).
  function bake(fl) {
    const t = perf.begin();
    perf.count('paint.bakes');
    const source = fl.live ? src : settled, size = fl.live ? liveSize : settledSize;
    const L = [0.35, 0.8, 0.5], ll = Math.hypot(...L);
    for (const m of [bakeColor, bakeMask]) {
      const u = m.uniforms;
      u.src.value = source.texture;
      u.srcSize.value.copy(size);
      u.slot.value.set(fl.slot.x, fl.slot.y, fl.w, fl.h);
      u.lin.value.set(...fl.base.map(c => Math.pow(c / 255, 2.2)));
    }
    for (const f of fl.targets) {
      const u0 = Math.max(fl.u0, f.umin), u1 = Math.min(fl.u1, f.umax);
      const v0 = Math.max(fl.v0, f.vmin), v1 = Math.min(fl.v1, f.vmax);
      if (u1 <= u0 || v1 <= v0) continue;
      const du = f.umax - f.umin, dv = f.vmax - f.vmin;
      const N = [0, 0, 0];
      N[f.axis] = f.sign;
      const H = new THREE.Vector3(L[0] / ll + N[0], L[1] / ll + N[1], L[2] / ll + N[2]).normalize();
      for (const m of [bakeColor, bakeMask]) {
        const u = m.uniforms;
        u.rect.value.set((u0 - f.umin) / du, (v0 - f.vmin) / dv, (u1 - f.umin) / du, (v1 - f.vmin) / dv);
        u.area.value.set(u0, v0, u1, v1);
        u.region.value.set(fl.u0, fl.v0, 0.5 * du / f.surf.w, 0.5 * dv / f.surf.h);
        u.U.value.set(0, 0, 0).setComponent(f.ua, 1);
        u.V.value.set(0, 0, 0).setComponent(f.va, 1);
        u.N.value.set(...N);
        u.H.value.copy(H);
      }
      blit.draw(f.surf.mask, bakeMask);
      blit.draw(f.surf.color, bakeColor);
      surfaces.touch(f);
    }
    if (fl.bottomRow) readBottomRow(fl, source, size);
    perf.end('paint.bake', t);
  }

  function readBottomRow(fl, source, size) {
    copyMat.uniforms.src.value = source.texture;
    copyMat.uniforms.srcSize.value.copy(size);
    copyMat.uniforms.srcOrigin.value.set(fl.slot.x, fl.slot.y);
    copyMat.uniforms.rect.value.set(0, 0, fl.w / UNIT_W, 1);
    copyMat.uniforms.area.value.set(0, 0, fl.w, 1);
    copyMat.uniforms.scale.value = 1 / ROW_SCALE;
    blit.draw(rowTarget, copyMat);
    copyMat.uniforms.scale.value = 1;
    readPixelsAsync(rowTarget, fl.w).then(px => {
      const row = new Float32Array(fl.w);
      for (let i = 0; i < fl.w; i++) row[i] = px[i * 4] / 255 * ROW_SCALE;
      onBottomRow(fl, row);
    }).catch(err => console.warn('paint row read failed', err));
  }

  // Reads the first w pixels of a render target without waiting for the GPU: the
  // pixels are copied into a buffer on the GPU, and fetched once a fence says the copy
  // is done. (three's readRenderTargetPixelsAsync queries the read format first, a
  // round trip that waits for all queued GPU work, as long as a synchronous read.)
  function readPixelsAsync(target, w) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    renderer.setRenderTarget(prev);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (gl.isContextLost()) { reject(new Error('context lost')); return; }
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED) { setTimeout(poll, 4); return; }
        gl.deleteSync(sync);
        const px = new Uint8Array(w * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(buf);
        resolve(px);
      };
      setTimeout(poll, 4);
    });
  }

  function remove(fl) {
    fl.removed = true;
    (fl.live ? liveSlots : settledSlots).free(fl.slot);
    flows.splice(flows.indexOf(fl), 1);
    if (fl.live) liveDirty = true;
    drawDirty = true;
  }

  function writeDrawInstances() {
    const a = drawGeo.attributes;
    flows.forEach((fl, i) => {
      const f = fl.face;
      const origin = [0, 0, 0], U = [0, 0, 0], V = [0, 0, 0], N = [0, 0, 0];
      origin[f.axis] = f.plane; origin[f.ua] = fl.u0; origin[f.va] = fl.v0;
      U[f.ua] = fl.u1 - fl.u0; V[f.va] = fl.v1 - fl.v0; N[f.axis] = f.sign;
      a.origin.array.set(origin, i * 3);
      a.axU.array.set(U, i * 3);
      a.axV.array.set(V, i * 3);
      a.nrm.array.set(N, i * 3);
      a.col.array.set([fl.color.r, fl.color.g, fl.color.b], i * 3);
      a.slot.array.set([fl.slot.x, fl.slot.y, fl.w, fl.h], i * 4);
      a.which.array[i] = fl.live ? 0 : 1;
    });
    for (const attr of Object.values(a)) if (attr.isInstancedBufferAttribute) attr.needsUpdate = true;
    drawGeo.instanceCount = flows.length;
  }

  function update(dt) {
    if (pendingInstant.length) runInstant();
    acc = Math.min(acc + dt, 4 * STEP);
    while (acc >= STEP) {
      acc -= STEP;
      for (const fl of flows.filter(f => f.live && stepCount - f.startStep >= LIVE_STEPS)) settle(fl);
      if (liveDirty) { writeStepInstances(flows.filter(f => f.live), false); liveDirty = false; }
      if (stepGeo.instanceCount) step(stepCount);
      stepCount++;
    }
    if (liveDirty) { writeStepInstances(flows.filter(f => f.live), false); liveDirty = false; }
    if (drawDirty) { writeDrawInstances(); drawDirty = false; }
    drawMat.uniforms.live.value = src.texture;
  }

  function clear() {
    flows.length = 0;
    pendingInstant = [];
    liveSlots.clear();
    settledSlots.clear();
    liveDirty = drawDirty = true;
  }

  return { add, update, clear, flows };
}

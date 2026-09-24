// GPU simulation of paint running down walls.
//
// Every fresh splat on a wall gets a small high resolution texture holding the paint
// thickness (R), whether a texel has been wetted (G) and whether it belonged to the
// original blob (B). A fragment shader advances it at a fixed rate: paint above what a
// texel can hold slides down, preferring wet and thick texels, and only breaks out
// onto dry wall where enough has piled up. That makes the paint sag inside the blob
// and run down in a few rivulets with drops at their tips.
//
// A quad just in front of the wall draws the paint from that texture with a crisp edge
// and lighting from the thickness, including a view dependent wet highlight. Settled
// flows are eventually baked into the wall's paint canvas to free GPU memory.

import * as THREE from 'three';

export const SIM_PPM = 96;       // simulation texels per meter
const STEP = 1 / 90;             // seconds per simulation step (at most one texel of travel)
const LIVE_TIME = 6;             // seconds a flow is simulated
const MAX_OVERLAYS = 150;        // older settled splats get baked into the surface canvas
const MAX_BAKING = 3;            // bakes waiting for their GPU read at the same time

const QUAD_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const STEP_FRAGMENT = `
  uniform sampler2D src;
  uniform vec2 size;      // texels
  uniform float seed;
  uniform float rate;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030) + seed);
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
  }
  vec4 cell(vec2 c) {
    if (c.x < 0.0 || c.x > size.x - 1.0 || c.y > size.y - 1.0) return vec4(0.0, 1.0, 0.0, -1.0); // walls of the region
    if (c.y < 0.0) return vec4(0.0, 1.0, 0.0, 1.0); // below the region: paint leaves
    return texture2D(src, (c + 0.5) / size);
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
    vec2 c = floor(vUv * size);
    vec4 me = texture2D(src, (c + 0.5) / size);
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
    gl_FragColor = vec4(h, wet, me.b, 1.0);
  }`;

const DRAW_VERTEX = `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const DRAW_FRAGMENT = `
  uniform sampler2D state;
  uniform vec2 texel;
  uniform vec3 color;
  uniform vec3 axisU;
  uniform vec3 axisV;
  uniform vec3 normal;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    float h = texture2D(state, vUv).r;
    float w = max(fwidth(h) * 0.8, 0.002);
    float a = smoothstep(0.045 - w, 0.045 + w, h);
    if (a <= 0.001) discard;
    float hx = texture2D(state, vUv + vec2(texel.x * 2.0, 0.0)).r - texture2D(state, vUv - vec2(texel.x * 2.0, 0.0)).r;
    float hy = texture2D(state, vUv + vec2(0.0, texel.y * 2.0)).r - texture2D(state, vUv - vec2(0.0, texel.y * 2.0)).r;
    vec3 n = normalize(-hx * 1.6 * axisU - hy * 1.6 * axisV + normal);
    vec3 L = normalize(vec3(0.35, 0.8, 0.5));
    vec3 V = normalize(cameraPosition - vWorld);
    float diff = 0.7 + 0.38 * max(dot(n, L), 0.0);
    float spec = pow(max(dot(n, normalize(L + V)), 0.0), 70.0) * 0.9;
    float rim = 1.0 - 0.16 * smoothstep(0.0, 0.9, h);
    vec3 col = color * diff * rim + spec;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

export function createPaintFlow(renderer, scene) {
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const simScene = new THREE.Scene();
  const stepMat = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, size: { value: new THREE.Vector2() }, seed: { value: 0 }, rate: { value: 0.5 } },
    vertexShader: QUAD_VERTEX, fragmentShader: STEP_FRAGMENT, depthTest: false, depthWrite: false,
  });
  const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stepMat);
  simScene.add(simQuad);

  const flows = [];
  let order = 0;
  let baking = 0; // bakes waiting for their asynchronous read

  function makeTarget(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
  }

  function step(fl) {
    stepMat.uniforms.src.value = fl.src;
    stepMat.uniforms.size.value.set(fl.w, fl.h);
    stepMat.uniforms.seed.value = fl.seed;
    stepMat.uniforms.rate.value = fl.rate;
    const target = fl.src === fl.a.texture ? fl.b : fl.a;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(prev);
    fl.src = target.texture;
    fl.draw.uniforms.state.value = target.texture;
    fl.rate *= 0.997; // paint slowly gets tacky
  }

  // region: { face, u0, u1, v0, v1 } in world meters on the face plane
  // blobs: [[u, v, radius]] in world meters, color: THREE.Color (linear), seed: int
  // flow: false renders the splat the same way without letting it run (floors).
  function add({ face, u0, u1, v0, v1, blobs, color, seed, instant, flow = true }) {
    const w = Math.max(8, Math.round((u1 - u0) * SIM_PPM));
    const h = Math.max(8, Math.round((v1 - v0) * SIM_PPM));

    // initial thickness: a dome per blob
    const data = new Float32Array(w * h * 4);
    for (const [bu, bv, br] of blobs) {
      const cx = (bu - u0) * SIM_PPM, cy = (bv - v0) * SIM_PPM, r = br * SIM_PPM;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, Math.ceil(cy + r + 1)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, Math.ceil(cx + r + 1)); x++) {
          const d2 = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const o = (y * w + x) * 4;
          data[o] = Math.max(data[o], 0.75 * Math.sqrt(1 - d2));
          data[o + 1] = 1;
          data[o + 2] = 1;
        }
      }
    }
    const init = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    init.minFilter = init.magFilter = THREE.NearestFilter;
    init.needsUpdate = true;

    const draw = new THREE.ShaderMaterial({
      uniforms: {
        state: { value: init }, texel: { value: new THREE.Vector2(1 / w, 1 / h) },
        color: { value: color }, axisU: { value: new THREE.Vector3() }, axisV: { value: new THREE.Vector3() },
        normal: { value: new THREE.Vector3() },
      },
      vertexShader: DRAW_VERTEX, fragmentShader: DRAW_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    draw.uniforms.axisU.value.setComponent(face.ua, 1);
    draw.uniforms.axisV.value.setComponent(face.va, 1);
    draw.uniforms.normal.value.setComponent(face.axis, face.sign);

    const pos = [];
    for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
      const p = [0, 0, 0];
      p[face.axis] = face.plane + face.sign * 0.002;
      p[face.ua] = u;
      p[face.va] = v;
      pos.push(...p);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo, draw);
    mesh.renderOrder = ++order;
    mesh.frustumCulled = false;

    const fl = {
      face, u0, u1, v0, v1, w, h, color, seed: (seed % 997) / 997,
      a: makeTarget(w, h), b: makeTarget(w, h), src: init, init,
      draw, mesh, rate: flow ? 0.5 : 0, time: 0, acc: 0, live: true,
    };
    step(fl); // copies the initial state onto the GPU
    init.dispose();

    if (!flow) settle(fl);
    else if (instant) {
      for (let i = 0; i < LIVE_TIME / STEP; i++) step(fl);
      settle(fl);
    }
    scene.add(mesh);
    flows.push(fl);
    return fl;
  }

  // Stop simulating; the second buffer isn't needed any more.
  function settle(fl) {
    fl.live = false;
    const spare = fl.src === fl.a.texture ? fl.b : fl.a;
    spare.dispose();
    fl.spare = spare;
  }

  function update(dt, bake) {
    for (const fl of flows) {
      if (!fl.live) continue;
      fl.time += dt;
      fl.acc += dt;
      let n = 0;
      while (fl.acc >= STEP && n < 4) { step(fl); fl.acc -= STEP; n++; }
      if (fl.time >= LIVE_TIME) settle(fl);
    }
    // Keep GPU memory bounded: bake the oldest settled splat into the surface canvas.
    // At most one new bake per frame, and the thickness is read back asynchronously:
    // a synchronous read waits for the GPU to finish all queued work (a hitch of up
    // to ~80 ms). The flow stays visible until its bake lands in the canvas.
    if (flows.length - baking > MAX_OVERLAYS && baking < MAX_BAKING) {
      const fl = flows.find(f => !f.live && !f.baking);
      if (fl) {
        fl.baking = true;
        baking++;
        readThicknessAsync(fl).then(thick => {
          if (!fl.removed) { bake(fl, thick); remove(fl); }
        }).catch(err => {
          console.warn('paint bake failed', err);
          if (!fl.removed) remove(fl);
        }).finally(() => { baking--; });
      }
    }
  }

  function halfToThickness(fl, raw) {
    const out = new Float32Array(fl.w * fl.h);
    for (let i = 0; i < out.length; i++) out[i] = THREE.DataUtils.fromHalfFloat(raw[i * 4]);
    return out;
  }

  async function readThicknessAsync(fl) {
    const target = fl.src === fl.a.texture ? fl.a : fl.b;
    const raw = new Uint16Array(fl.w * fl.h * 4);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, fl.w, fl.h, raw);
    return halfToThickness(fl, raw);
  }

  // Thickness grid of a flow (CPU copy), used to bake it into the wall canvas.
  function readThickness(fl) {
    const target = fl.src === fl.a.texture ? fl.a : fl.b;
    const raw = new Uint16Array(fl.w * fl.h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, fl.w, fl.h, raw);
    return halfToThickness(fl, raw);
  }

  function remove(fl) {
    fl.removed = true;
    scene.remove(fl.mesh);
    fl.mesh.geometry.dispose();
    fl.draw.dispose();
    if (fl.spare !== fl.a) fl.a.dispose();
    if (fl.spare !== fl.b) fl.b.dispose();
    flows.splice(flows.indexOf(fl), 1);
  }

  function clear() {
    while (flows.length) remove(flows[0]);
  }

  return { add, update, clear, flows, readThickness, remove };
}

// Paint on the level's surfaces, kept on the GPU in one shared texture.
//
// Every visible box face gets a rectangle in a paint atlas: two render targets, the
// paint color (sRGB) and a coverage mask. The level is one mesh whose shader
// (PAINT_FRAGMENT in client.js) cuts a sharp, anti-aliased edge at 50% coverage, so
// borders stay smooth although the textures are low resolution. The color is painted
// slightly larger than the mask so edges don't get a light fringe. Splats and puddles
// are drawn straight into the atlas by small shaders; nothing is read back or uploaded
// from the CPU.
//
// Rectangles are PAD texels apart. Draws that reach a face's edge also fill its
// padding with the edge's paint (the shaders clamp to the face), so filtering at the
// edge doesn't blend in the neighbour, and mipmaps stop at MAX_LEVEL so that a texel
// never spans two faces. Mipmaps are rebuilt at most every MIP_INTERVAL ms, not after
// every draw: joining a running match replays thousands of splats.

import * as THREE from 'three';
import { RECT_VERTEX } from './blit.js';

const MAX_CIRCLES = 40;
const MAX_ELLIPSES = 16;
const PAD = 16;          // texels around every face's rectangle
const MAX_LEVEL = 3;     // coarsest mip level (8 x 8 texels), still inside the padding
const MIP_INTERVAL = 100;

const SRGB_TO_LINEAR = `
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }`;

// A splat in four layers so the paint reads as a thick, wet blob: a darker rim, the
// body, and glossy highlights towards the upper left. Circles are (u, v, radius) in
// meters on the face; px is the size of one texel in meters.
const SPLAT_FRAGMENT = `
  uniform vec3 circles[${MAX_CIRCLES}];
  uniform int count;
  uniform float px;
  uniform float pass; // 0: color, 1: coverage mask
  uniform vec3 rimCol, bodyCol, hl1Col, hl2Col; // sRGB
  uniform vec4 bounds; // the face, so its padding repeats the edge
  varying vec2 vP;
  ${SRGB_TO_LINEAR}
  vec2 p;
  float disc(vec2 c, float r) { return clamp(0.5 + (r - length(p - c)) / px, 0.0, 1.0); }
  void main() {
    p = clamp(vP, bounds.xy, bounds.zw);
    float m = 0.0, rim = 0.0, body = 0.0, h1 = 0.0, h2 = 0.0;
    for (int i = 0; i < ${MAX_CIRCLES}; i++) {
      if (i >= count) break;
      vec2 c = circles[i].xy;
      float r = circles[i].z;
      m = max(m, disc(c, r));
      rim = max(rim, disc(c, r + 2.0 * px));
      body = max(body, disc(c + vec2(-0.04, 0.04) * r, r * 0.86));
      if (r >= 3.0 * px) h1 = max(h1, disc(c + vec2(-0.22, 0.26) * r, r * 0.5));
      if (r >= 4.0 * px) h2 = max(h2, disc(c + vec2(-0.35, 0.4) * r, r * 0.16));
    }
    if (pass > 0.5) {
      if (m <= 0.0) discard;
      gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
      return;
    }
    if (rim <= 0.0) discard;
    vec3 col = mix(rimCol, bodyCol, body);
    col = mix(col, hl1Col, h1 * 0.28);
    col = mix(col, hl2Col, h2 * 0.55);
    gl_FragColor = vec4(toLinear(col), rim);
  }`;

// Removes paint: the coverage mask drops to 1 - disc (min blending), so the level's
// white base shows again. The color below is left alone, the mask hides it.
const ERASE_FRAGMENT = `
  uniform vec3 circles[${MAX_CIRCLES}];
  uniform int count;
  uniform float px;
  uniform vec4 bounds;
  varying vec2 vP;
  vec2 p;
  float disc(vec2 c, float r) { return clamp(0.5 + (r - length(p - c)) / px, 0.0, 1.0); }
  void main() {
    p = clamp(vP, bounds.xy, bounds.zw);
    float m = 0.0;
    for (int i = 0; i < ${MAX_CIRCLES}; i++) {
      if (i >= count) break;
      m = max(m, disc(circles[i].xy, circles[i].z));
    }
    if (m <= 0.0) discard;
    gl_FragColor = vec4(1.0 - m, 0.0, 0.0, 1.0);
  }`;

// Flat ellipses (u, v, radius u, radius v) in meters; the color reaches `grow`
// meters beyond the mask.
const ELLIPSE_FRAGMENT = `
  uniform vec4 ellipses[${MAX_ELLIPSES}];
  uniform int count;
  uniform float px;
  uniform float grow;
  uniform float pass;
  uniform vec3 color; // sRGB
  uniform vec4 bounds;
  varying vec2 vP;
  ${SRGB_TO_LINEAR}
  vec2 p;
  float ellipse(vec4 e, float g) {
    vec2 r = e.zw + g;
    float d = (length((p - e.xy) / r) - 1.0) * min(r.x, r.y);
    return clamp(0.5 - d / px, 0.0, 1.0);
  }
  void main() {
    p = clamp(vP, bounds.xy, bounds.zw);
    float a = 0.0;
    for (int i = 0; i < ${MAX_ELLIPSES}; i++) {
      if (i >= count) break;
      a = max(a, ellipse(ellipses[i], pass > 0.5 ? 0.0 : grow));
    }
    if (a <= 0.0) discard;
    gl_FragColor = pass > 0.5 ? vec4(a, 0.0, 0.0, 1.0) : vec4(toLinear(color), a);
  }`;

// Places w x h rectangles into a width x height area (skyline, bottom left). Returns
// [x, y] per rectangle, or null if they don't fit.
function pack(sizes, width, height) {
  const order = sizes.map((s, i) => i).sort((a, b) =>
    Math.max(...sizes[b]) - Math.max(...sizes[a]) || sizes[b][0] * sizes[b][1] - sizes[a][0] * sizes[a][1]);
  const out = [];
  let sky = [{ x: 0, y: 0, w: width }];
  for (const i of order) {
    const [w, h] = sizes[i];
    let best = null;
    for (let s = 0; s < sky.length && sky[s].x + w <= width; s++) {
      let y = 0;
      for (let j = s, left = w; left > 0; left -= sky[j].w, j++) y = Math.max(y, sky[j].y);
      if (y + h <= height && (!best || y < best.y)) best = { x: sky[s].x, y };
    }
    if (!best) return null;
    out[i] = [best.x, best.y];
    const top = { x: best.x, y: best.y + h, w };
    const next = [];
    for (const s of sky) {
      if (s.x + s.w <= top.x || s.x >= top.x + w) { next.push(s); continue; }
      if (s.x < top.x) next.push({ x: s.x, y: s.y, w: top.x - s.x });
      if (s.x + s.w > top.x + w) next.push({ x: top.x + w, y: s.y, w: s.x + s.w - top.x - w });
    }
    next.push(top);
    next.sort((a, b) => a.x - b.x);
    sky = [];
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && last.y === s.y) last.w += s.w; else sky.push({ ...s });
    }
  }
  return out;
}

export function createSurfaces(renderer, blit) {
  const gl = renderer.getContext();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const white = new THREE.Color(1, 1, 1), black = new THREE.Color(0, 0, 0);
  const size = new THREE.Vector2();
  let color = null, mask = null;
  let dirty = false, lastMips = 0;

  // Color layers blend over the paint below; the mask only grows.
  const blending = {
    color: { transparent: true, blending: THREE.NormalBlending },
    mask: { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor },
  };
  const makeMaterials = (fragmentShader, uniforms) => Object.fromEntries(['color', 'mask'].map((pass, i) => [pass,
    new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(uniforms), pass: { value: i },
        rect: { value: new THREE.Vector4() }, area: { value: new THREE.Vector4() }, bounds: { value: new THREE.Vector4() },
      },
      vertexShader: RECT_VERTEX, fragmentShader, depthTest: false, depthWrite: false, ...blending[pass],
    })]));

  const splatMats = makeMaterials(SPLAT_FRAGMENT, {
    circles: { value: new Float32Array(MAX_CIRCLES * 3) }, count: { value: 0 }, px: { value: 0.03 },
    rimCol: { value: new THREE.Vector3() }, bodyCol: { value: new THREE.Vector3() },
    hl1Col: { value: new THREE.Vector3() }, hl2Col: { value: new THREE.Vector3() },
  });
  const ellipseMats = makeMaterials(ELLIPSE_FRAGMENT, {
    ellipses: { value: new Float32Array(MAX_ELLIPSES * 4) }, count: { value: 0 }, px: { value: 0.03 },
    grow: { value: 0 }, color: { value: new THREE.Vector3() },
  });

  const eraseMat = new THREE.ShaderMaterial({
    uniforms: {
      circles: { value: new Float32Array(MAX_CIRCLES * 3) }, count: { value: 0 }, px: { value: 0.03 },
      rect: { value: new THREE.Vector4() }, area: { value: new THREE.Vector4() }, bounds: { value: new THREE.Vector4() },
    },
    vertexShader: RECT_VERTEX, fragmentShader: ERASE_FRAGMENT, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.MinEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const eraseMats = { color: eraseMat, mask: eraseMat }; // for place(); only the mask is drawn

  // Compile the shaders now instead of on the first splat (empty rectangles, nothing is drawn).
  const warmTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  for (const m of [splatMats.color, splatMats.mask, ellipseMats.color, ellipseMats.mask, eraseMat]) blit.draw(warmTarget, m);
  warmTarget.dispose();

  function makeTarget(options) {
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      depthBuffer: false, anisotropy: aniso, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, ...options,
    });
    renderer.initRenderTarget(rt);
    // Storage for the mip levels is allocated now; from here on they're rebuilt in flush().
    rt.texture.generateMipmaps = false;
    renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(rt.texture).__webglTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_LEVEL);
    return rt;
  }

  // Gives every face ({ umin, umax, vmin, vmax, texels: [w, h] }) its rectangle in the
  // atlas (face.surf) and creates the atlas.
  function build(faces) {
    const sizes = faces.map(f => [f.texels[0] + 2 * PAD, f.texels[1] + 2 * PAD]);
    const max = renderer.capabilities.maxTextureSize;
    let spots = null;
    for (const [w, h] of [[4096, 4096], [4096, 8192], [8192, 8192]]) {
      if (w > max || h > max) break;
      spots = pack(sizes, w, h);
      if (spots) { size.set(w, h); break; }
    }
    if (!spots) throw new Error('The level does not fit into one paint texture');
    faces.forEach((f, i) => {
      const [w, h] = f.texels;
      f.surf = {
        x: spots[i][0] + PAD, y: spots[i][1] + PAD, w, h,
        px: 0.5 * ((f.umax - f.umin) / w + (f.vmax - f.vmin) / h),
      };
    });
    color = makeTarget({ colorSpace: THREE.SRGBColorSpace });
    mask = makeTarget({ format: THREE.RedFormat });
    clear();
  }

  function clear() {
    blit.fill(color, white);
    blit.fill(mask, black);
    dirty = true;
  }

  // Atlas texture coordinates of the point (u, v) of a face.
  function uv(f, u, v) {
    const s = f.surf;
    return [(s.x + (u - f.umin) / (f.umax - f.umin) * s.w) / size.x, (s.y + (v - f.vmin) / (f.vmax - f.vmin) * s.h) / size.y];
  }

  // Where to draw the box (u0, v0)-(u1, v1) of a face: clipped to the face and its
  // padding. rect: atlas coordinates, area: the same box in meters, bounds: the face
  // (shaders clamp to it). null if the box misses the face.
  function region(f, u0, v0, u1, v1) {
    const s = f.surf, du = f.umax - f.umin, dv = f.vmax - f.vmin;
    const padU = PAD * du / s.w, padV = PAD * dv / s.h;
    u0 = Math.max(u0, f.umin - padU); v0 = Math.max(v0, f.vmin - padV);
    u1 = Math.min(u1, f.umax + padU); v1 = Math.min(v1, f.vmax + padV);
    if (u1 <= u0 || v1 <= v0) return null;
    return { rect: [...uv(f, u0, v0), ...uv(f, u1, v1)], area: [u0, v0, u1, v1], bounds: [f.umin, f.vmin, f.umax, f.vmax] };
  }

  function apply(material, reg) {
    const u = material.uniforms;
    u.rect.value.set(...reg.rect);
    u.area.value.set(...reg.area);
    u.bounds.value.set(...reg.bounds);
  }

  // Sets both materials up for the box (u0, v0)-(u1, v1) of a face; false if empty.
  function place(face, mats, u0, v0, u1, v1) {
    const reg = region(face, u0, v0, u1, v1);
    if (!reg) return false;
    for (const m of [mats.color, mats.mask]) {
      apply(m, reg);
      m.uniforms.px.value = face.surf.px;
    }
    return true;
  }

  const setRgb = (v, c, k = 1) => v.set(Math.min(255, c[0] * k) / 255, Math.min(255, c[1] * k) / 255, Math.min(255, c[2] * k) / 255);
  const mixWhite = (c, t) => [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];

  // circles: [[u, v, r]] in meters on the face, base: sRGB 0..255.
  function splat(face, circles, base) {
    const px = face.surf.px;
    for (let i = 0; i < circles.length; i += MAX_CIRCLES) {
      const chunk = circles.slice(i, i + MAX_CIRCLES);
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const [u, v, r] of chunk) {
        const reach = r + 4 * px;
        u0 = Math.min(u0, u - reach); v0 = Math.min(v0, v - reach);
        u1 = Math.max(u1, u + reach); v1 = Math.max(v1, v + reach);
      }
      if (!place(face, splatMats, u0, v0, u1, v1)) continue;
      for (const m of [splatMats.color, splatMats.mask]) {
        const arr = m.uniforms.circles.value;
        chunk.forEach(([u, v, r], k) => { arr[k * 3] = u; arr[k * 3 + 1] = v; arr[k * 3 + 2] = r; });
        m.uniforms.count.value = chunk.length;
      }
      const cu = splatMats.color.uniforms;
      setRgb(cu.rimCol.value, base, 0.72);
      setRgb(cu.bodyCol.value, base);
      setRgb(cu.hl1Col.value, mixWhite(base, 0.55));
      setRgb(cu.hl2Col.value, mixWhite(base, 0.85));
      blit.draw(mask, splatMats.mask);
      blit.draw(color, splatMats.color);
    }
    dirty = true;
  }

  // Takes the paint off: circles as for splat().
  function erase(face, circles) {
    const px = face.surf.px;
    for (let i = 0; i < circles.length; i += MAX_CIRCLES) {
      const chunk = circles.slice(i, i + MAX_CIRCLES);
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const [u, v, r] of chunk) {
        const reach = r + 2 * px;
        u0 = Math.min(u0, u - reach); v0 = Math.min(v0, v - reach);
        u1 = Math.max(u1, u + reach); v1 = Math.max(v1, v + reach);
      }
      if (!place(face, eraseMats, u0, v0, u1, v1)) continue;
      const arr = eraseMat.uniforms.circles.value;
      chunk.forEach(([u, v, r], k) => { arr[k * 3] = u; arr[k * 3 + 1] = v; arr[k * 3 + 2] = r; });
      eraseMat.uniforms.count.value = chunk.length;
      blit.draw(mask, eraseMat);
    }
    dirty = true;
  }

  // list: [[u, v, ru, rv]] in meters, rgb: sRGB 0..255, grow: meters the color reaches past the mask.
  function ellipses(face, list, rgb, grow) {
    for (let i = 0; i < list.length; i += MAX_ELLIPSES) {
      const chunk = list.slice(i, i + MAX_ELLIPSES);
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const [u, v, ru, rv] of chunk) {
        const m = grow + 2 * face.surf.px;
        u0 = Math.min(u0, u - ru - m); v0 = Math.min(v0, v - rv - m);
        u1 = Math.max(u1, u + ru + m); v1 = Math.max(v1, v + rv + m);
      }
      if (!place(face, ellipseMats, u0, v0, u1, v1)) continue;
      for (const m of [ellipseMats.color, ellipseMats.mask]) {
        const arr = m.uniforms.ellipses.value;
        chunk.forEach((e, k) => arr.set(e, k * 4));
        m.uniforms.count.value = chunk.length;
        m.uniforms.grow.value = grow;
      }
      setRgb(ellipseMats.color.uniforms.color.value, rgb);
      blit.draw(mask, ellipseMats.mask);
      blit.draw(color, ellipseMats.color);
    }
    dirty = true;
  }

  function touch() { dirty = true; }

  // Rebuilds the mipmaps if the atlas changed (at most every MIP_INTERVAL ms).
  function flush(now = performance.now()) {
    if (!dirty || now - lastMips < MIP_INTERVAL) return;
    dirty = false;
    lastMips = now;
    for (const rt of [color, mask]) {
      renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(rt.texture).__webglTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  return {
    build, clear, uv, region, apply, splat, erase, ellipses, touch, flush,
    get color() { return color; }, get mask() { return mask; },
  };
}

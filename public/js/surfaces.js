// Paint on the level's surfaces, kept on the GPU.
//
// Every visible box face has two render targets: the paint color (sRGB) and a
// coverage mask. The face shader (PAINT_FRAGMENT in client.js) cuts a sharp,
// anti-aliased edge at 50% coverage, so borders stay smooth although the textures
// are low resolution. The color is painted slightly larger than the mask so edges
// don't get a light fringe. Splats and puddles are drawn straight into these
// targets by small shaders; nothing is read back or uploaded from the CPU.
//
// Mipmaps are regenerated once per frame for the targets that changed (flush),
// not after every draw: joining a running match replays thousands of splats.

import * as THREE from 'three';
import { RECT_VERTEX } from './blit.js';

const MAX_CIRCLES = 40;
const MAX_ELLIPSES = 16;

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
  varying vec2 vP;
  ${SRGB_TO_LINEAR}
  float disc(vec2 c, float r) { return clamp(0.5 + (r - length(vP - c)) / px, 0.0, 1.0); }
  void main() {
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

// Flat ellipses (u, v, radius u, radius v) in meters; the color reaches `grow`
// meters beyond the mask.
const ELLIPSE_FRAGMENT = `
  uniform vec4 ellipses[${MAX_ELLIPSES}];
  uniform int count;
  uniform float px;
  uniform float grow;
  uniform float pass;
  uniform vec3 color; // sRGB
  varying vec2 vP;
  ${SRGB_TO_LINEAR}
  float ellipse(vec4 e, float g) {
    vec2 r = e.zw + g;
    float d = (length((vP - e.xy) / r) - 1.0) * min(r.x, r.y);
    return clamp(0.5 - d / px, 0.0, 1.0);
  }
  void main() {
    float a = 0.0;
    for (int i = 0; i < ${MAX_ELLIPSES}; i++) {
      if (i >= count) break;
      a = max(a, ellipse(ellipses[i], pass > 0.5 ? 0.0 : grow));
    }
    if (a <= 0.0) discard;
    gl_FragColor = pass > 0.5 ? vec4(a, 0.0, 0.0, 1.0) : vec4(toLinear(color), a);
  }`;

export function createSurfaces(renderer, blit) {
  const gl = renderer.getContext();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const dirty = new Set();
  const white = new THREE.Color(1, 1, 1), black = new THREE.Color(0, 0, 0);

  // Color layers blend over the paint below; the mask only grows.
  const blending = {
    color: { transparent: true, blending: THREE.NormalBlending },
    mask: { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor },
  };
  const makeMaterials = (fragmentShader, uniforms) => Object.fromEntries(['color', 'mask'].map((pass, i) => [pass,
    new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(uniforms), rect: { value: new THREE.Vector4() }, area: { value: new THREE.Vector4() }, pass: { value: i } },
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

  // Compile the shaders now instead of on the first splat (empty rectangles, nothing is drawn).
  const warmTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  for (const m of [splatMats.color, splatMats.mask, ellipseMats.color, ellipseMats.mask]) blit.draw(warmTarget, m);
  warmTarget.dispose();

  function makeTarget(w, h, options) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false, anisotropy: aniso, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, ...options,
    });
    renderer.initRenderTarget(rt);
    // Storage for the mip levels is allocated now; from here on they're rebuilt in flush().
    rt.texture.generateMipmaps = false;
    return rt;
  }

  // Paint targets for a face of w x h texels (the face spans umin..umax, vmin..vmax).
  function create(face, w, h) {
    face.surf = {
      w, h,
      color: makeTarget(w, h, { colorSpace: THREE.SRGBColorSpace }),
      mask: makeTarget(w, h, { format: THREE.RedFormat }),
      px: 0.5 * ((face.umax - face.umin) / w + (face.vmax - face.vmin) / h),
    };
    clear(face);
  }

  function clear(face) {
    blit.fill(face.surf.color, white);
    blit.fill(face.surf.mask, black);
    dirty.add(face.surf);
  }

  // Sets rect/area to the box (u0, v0)-(u1, v1) clipped to the face; false if empty.
  function place(face, mats, u0, v0, u1, v1) {
    u0 = Math.max(u0, face.umin); v0 = Math.max(v0, face.vmin);
    u1 = Math.min(u1, face.umax); v1 = Math.min(v1, face.vmax);
    if (u1 <= u0 || v1 <= v0) return false;
    const du = face.umax - face.umin, dv = face.vmax - face.vmin;
    for (const m of [mats.color, mats.mask]) {
      m.uniforms.rect.value.set((u0 - face.umin) / du, (v0 - face.vmin) / dv, (u1 - face.umin) / du, (v1 - face.vmin) / dv);
      m.uniforms.area.value.set(u0, v0, u1, v1);
      m.uniforms.px.value = face.surf.px;
    }
    return true;
  }

  const setRgb = (v, c, k = 1) => v.set(Math.min(255, c[0] * k) / 255, Math.min(255, c[1] * k) / 255, Math.min(255, c[2] * k) / 255);
  const mixWhite = (c, t) => [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];

  // circles: [[u, v, r]] in meters on the face, base: sRGB 0..255.
  function splat(face, circles, base) {
    const { color, mask } = splatMats;
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
      for (const m of [color, mask]) {
        const arr = m.uniforms.circles.value;
        chunk.forEach(([u, v, r], k) => { arr[k * 3] = u; arr[k * 3 + 1] = v; arr[k * 3 + 2] = r; });
        m.uniforms.count.value = chunk.length;
      }
      setRgb(color.uniforms.rimCol.value, base, 0.72);
      setRgb(color.uniforms.bodyCol.value, base);
      setRgb(color.uniforms.hl1Col.value, mixWhite(base, 0.55));
      setRgb(color.uniforms.hl2Col.value, mixWhite(base, 0.85));
      blit.draw(face.surf.mask, mask);
      blit.draw(face.surf.color, color);
    }
    dirty.add(face.surf);
  }

  // list: [[u, v, ru, rv]] in meters, rgb: sRGB 0..255, grow: meters the color reaches past the mask.
  function ellipses(face, list, rgb, grow) {
    const { color, mask } = ellipseMats;
    for (let i = 0; i < list.length; i += MAX_ELLIPSES) {
      const chunk = list.slice(i, i + MAX_ELLIPSES);
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const [u, v, ru, rv] of chunk) {
        const m = grow + 2 * face.surf.px;
        u0 = Math.min(u0, u - ru - m); v0 = Math.min(v0, v - rv - m);
        u1 = Math.max(u1, u + ru + m); v1 = Math.max(v1, v + rv + m);
      }
      if (!place(face, ellipseMats, u0, v0, u1, v1)) continue;
      for (const m of [color, mask]) {
        const arr = m.uniforms.ellipses.value;
        chunk.forEach((e, k) => arr.set(e, k * 4));
        m.uniforms.count.value = chunk.length;
        m.uniforms.grow.value = grow;
      }
      setRgb(color.uniforms.color.value, rgb);
      blit.draw(face.surf.mask, mask);
      blit.draw(face.surf.color, color);
    }
    dirty.add(face.surf);
  }

  function touch(face) { dirty.add(face.surf); }

  // Rebuilds the mipmaps of the targets drawn into since the last frame.
  function flush() {
    for (const s of dirty) {
      for (const rt of [s.color, s.mask]) {
        renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(rt.texture).__webglTexture);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
    }
    dirty.clear();
  }

  return { create, clear, splat, ellipses, touch, flush };
}

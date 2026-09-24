// Liquid paint in the air: screen space metaballs, the technique from Mix and Jam's
// Splatoon ink recreation. Droplets are drawn as soft spheres of "density" into an
// offscreen buffer, where nearby droplets add up and merge. A final pass thresholds
// that density into gooey blobs with glossy liquid shading and composites them over
// the scene. The scene is rendered into a buffer with depth first, so droplets behind
// walls are hidden.

import * as THREE from 'three';

const MAX_DROPS = 1024;
const GRAVITY = 9.8;

const DROP_VERTEX = `
  attribute vec3 iPos;
  attribute float iRadius;
  attribute vec3 iColor;
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vDepth;
  varying float vRadius;
  void main() {
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    mv.xy += position.xy * iRadius;
    vQuad = position.xy;
    vColor = iColor;
    vDepth = -mv.z;
    vRadius = iRadius;
    gl_Position = projectionMatrix * mv;
  }`;

const DROP_FRAGMENT = `
  #include <packing>
  uniform sampler2D sceneDepth;
  uniform vec2 resolution;
  uniform float near;
  uniform float far;
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vDepth;
  varying float vRadius;
  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 >= 1.0) discard;
    // hidden behind the level?
    float d = texture2D(sceneDepth, gl_FragCoord.xy / resolution).x;
    float sceneZ = -perspectiveDepthToViewZ(d, near, far);
    if (vDepth - vRadius * sqrt(1.0 - r2) > sceneZ + 0.02) discard;
    float density = (1.0 - r2) * (1.0 - r2);
    gl_FragColor = vec4(vColor * density, density);
  }`;

const COMPOSITE_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const COMPOSITE_FRAGMENT = `
  uniform sampler2D sceneColor;
  uniform sampler2D fluid;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    vec4 scene = texture2D(sceneColor, vUv);
    vec4 f = texture2D(fluid, vUv);
    float a = f.a;
    float w = max(fwidth(a) * 0.7, 0.002);
    float cover = smoothstep(0.32 - w, 0.32 + w, a);
    vec3 col = scene.rgb;
    if (cover > 0.0) {
      vec3 paint = f.rgb / max(a, 1e-4);
      // normal from the density slope makes the blobs look round and wet
      float ax = texture2D(fluid, vUv + vec2(texel.x, 0.0)).a - texture2D(fluid, vUv - vec2(texel.x, 0.0)).a;
      float ay = texture2D(fluid, vUv + vec2(0.0, texel.y)).a - texture2D(fluid, vUv - vec2(0.0, texel.y)).a;
      vec3 n = normalize(vec3(-ax * 2.5, -ay * 2.5, 1.0));
      vec3 L = normalize(vec3(-0.45, 0.6, 0.65));
      float diff = 0.72 + 0.4 * max(dot(n, L), 0.0);
      float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 45.0) * 0.85;
      col = mix(scene.rgb, paint * diff + spec, cover);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

export function createFluid(renderer) {
  // --- droplet geometry: one instanced quad per droplet
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iRadius = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS), 1).setUsage(THREE.DynamicDrawUsage);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iRadius', iRadius);
  geo.setAttribute('iColor', iColor);
  geo.instanceCount = 0;

  const dropMat = new THREE.ShaderMaterial({
    uniforms: {
      sceneDepth: { value: null }, resolution: { value: new THREE.Vector2() },
      near: { value: 0.05 }, far: { value: 250 },
    },
    vertexShader: DROP_VERTEX, fragmentShader: DROP_FRAGMENT,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const dropMesh = new THREE.Mesh(geo, dropMat);
  dropMesh.frustumCulled = false;
  const dropScene = new THREE.Scene();
  dropScene.add(dropMesh);

  const compositeMat = new THREE.ShaderMaterial({
    uniforms: { sceneColor: { value: null }, fluid: { value: null }, texel: { value: new THREE.Vector2() } },
    vertexShader: COMPOSITE_VERTEX, fragmentShader: COMPOSITE_FRAGMENT, depthTest: false, depthWrite: false,
  });
  const compositeScene = new THREE.Scene();
  compositeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMat));
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // --- render targets, resized with the canvas
  let sceneRT = null, fluidRT = null, width = 0, height = 0;
  function ensureTargets() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (sceneRT && size.x === width && size.y === height) return;
    width = size.x; height = size.y;
    sceneRT?.dispose(); fluidRT?.dispose();
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.type = THREE.UnsignedIntType;
    sceneRT = new THREE.WebGLRenderTarget(width, height, { samples: 4, depthTexture, type: THREE.HalfFloatType });
    // half resolution is plenty for soft blobs, the threshold keeps edges crisp
    fluidRT = new THREE.WebGLRenderTarget(Math.ceil(width / 2), Math.ceil(height / 2), {
      type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    dropMat.uniforms.resolution.value.set(fluidRT.width, fluidRT.height);
    compositeMat.uniforms.texel.value.set(1 / fluidRT.width, 1 / fluidRT.height);
  }

  // --- droplets
  const drops = [];  // simulated splash droplets
  const blobs = [];  // one-frame blobs (paint in flight), refilled every frame

  function color(hexOrColor) {
    return hexOrColor.isColor ? hexOrColor : new THREE.Color(hexOrColor);
  }

  // A burst of droplets thrown off an impact. normal: surface normal [x, y, z].
  function splash(pos, normal, paint, { count = 12, speed = 3.2, size = 0.09, life = 0.6 } = {}) {
    const c = color(paint);
    const n = new THREE.Vector3(...normal).normalize();
    // two tangents of the surface
    const t1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0);
    t1.cross(n).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1);
    for (let i = 0; i < count && drops.length < MAX_DROPS - 64; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = speed * (0.35 + Math.random() * 0.9);
      const side = speed * (0.4 + Math.random() * 0.9);
      const v = n.clone().multiplyScalar(out)
        .addScaledVector(t1, Math.cos(a) * side)
        .addScaledVector(t2, Math.sin(a) * side);
      const r = size * (0.5 + Math.random() * 0.9);
      drops.push({
        p: new THREE.Vector3(...pos).addScaledVector(n, 0.05), v, r0: r, r,
        c, age: 0, life: life * (0.6 + Math.random() * 0.8),
      });
    }
  }

  // Adds a blob for this frame only (projectiles are rebuilt every frame).
  function blob(pos, radius, paint) {
    blobs.push({ p: pos, r: radius, c: color(paint) });
  }

  function update(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      d.v.y -= GRAVITY * dt;
      d.v.multiplyScalar(Math.exp(-0.8 * dt)); // a little air drag
      d.p.addScaledVector(d.v, dt);
      const k = d.age / d.life;
      d.r = d.r0 * (1 - k * k);
      if (k >= 1 || d.p.y < -0.2) drops.splice(i, 1);
    }
  }

  function clear() {
    drops.length = 0;
    blobs.length = 0;
  }

  // Renders the scene with the liquid on top (replaces renderer.render for the game).
  function render(scene, camera) {
    ensureTargets();
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    let n = 0;
    const put = (p, r, c) => {
      if (n >= MAX_DROPS || r <= 0.002) return;
      iPos.setXYZ(n, p.x, p.y, p.z);
      iRadius.setX(n, r);
      iColor.setXYZ(n, c.r, c.g, c.b);
      n++;
    };
    for (const d of drops) put(d.p, d.r, d.c);
    for (const b of blobs) put(b.p, b.r, b.c);
    blobs.length = 0;
    geo.instanceCount = n;
    iPos.needsUpdate = iRadius.needsUpdate = iColor.needsUpdate = true;

    dropMat.uniforms.sceneDepth.value = sceneRT.depthTexture;
    dropMat.uniforms.near.value = camera.near;
    dropMat.uniforms.far.value = camera.far;
    renderer.setRenderTarget(fluidRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (n) renderer.render(dropScene, camera);

    compositeMat.uniforms.sceneColor.value = sceneRT.texture;
    compositeMat.uniforms.fluid.value = fluidRT.texture;
    renderer.setRenderTarget(null);
    renderer.render(compositeScene, orthoCam);
  }

  return { splash, blob, update, render, clear, drops };
}

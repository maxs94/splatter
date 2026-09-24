// Draws a material over a rectangle of a render target, without clearing it.
// Used for everything that paints on the GPU: splats and baked paint on the level's
// surfaces (js/surfaces.js, js/paintflow.js) and the paint simulation's atlases.
//
// Materials get the quad corner in `position.xy` (0..1). RECT_VERTEX maps it onto
// `rect` (the target area in 0..1 texture coordinates) and passes the matching point
// of `area` (the same rectangle in the caller's units, e.g. meters on a wall) as vP.

import * as THREE from 'three';

export const RECT_VERTEX = `
  uniform vec4 rect;
  uniform vec4 area;
  varying vec2 vP;
  void main() {
    vP = mix(area.xy, area.zw, position.xy);
    gl_Position = vec4(mix(rect.xy, rect.zw, position.xy) * 2.0 - 1.0, 0.0, 1.0);
  }`;

export function createBlitter(renderer) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(quad);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const prevClear = new THREE.Color();

  function draw(target, material, geometry = quad) {
    const prev = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    renderer.autoClear = false;
    mesh.material = material;
    mesh.geometry = geometry;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.autoClear = autoClear;
  }

  function fill(target, color, alpha = 1) {
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(color, alpha);
    renderer.setRenderTarget(target);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  return { draw, fill };
}

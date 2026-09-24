// Lobby scene: every joined player stands on a small stage in their chosen color,
// dancing, with a name tag above their head.

import * as THREE from 'three';
import { PALETTE } from '/shared/game.js';
import { createCharacter, poseCharacter, setAnim, funClipNames, headPosition, placeLabel } from './characters.js';

const CROWN = '<svg class="crown" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 14 L0 3 L7 8 L12 0 L17 8 L24 3 L22 14 Z"/></svg>';
const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

export function createLobby(renderer, labelsEl, panelWidth) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f2f4);
  scene.fog = new THREE.Fog(0xf2f2f4, 12, 26);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc8ccd4, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 8, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 64),
    new THREE.MeshStandardMaterial({ color: 0xe6e6ea, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 1.7, 7.2);
  camera.lookAt(0, 1.0, 0);

  const entries = new Map(); // id -> { ch, label, color }
  let labelsHidden = true;

  function setPlayers(players, leaderId, meId) {
    for (const [id, e] of entries) {
      if (!players.some(p => p.id === id)) {
        scene.remove(e.ch.root);
        e.label.remove();
        entries.delete(id);
      }
    }
    players.forEach((p, i) => {
      let e = entries.get(p.id);
      if (!e) {
        const body = new THREE.MeshStandardMaterial({ roughness: 0.55 });
        // no gun in the lobby, just the player dancing
        const ch = createCharacter({ bodyMat: body, castShadow: true });
        // Every player loops their own silly dance; ids are sequential, so neighbours differ.
        const fun = funClipNames();
        setAnim(ch, fun[p.id % fun.length], 0);
        ch.actions[ch.state].time = Math.random() * ch.actions[ch.state].getClip().duration;
        scene.add(ch.root);
        const label = document.createElement('div');
        label.className = 'name-label';
        label.hidden = labelsHidden;
        labelsEl.appendChild(label);
        e = { ch, label, body };
        entries.set(p.id, e);
      }
      const color = new THREE.Color(PALETTE[p.color]);
      e.body.color.copy(color);
      e.label.style.setProperty('--c', PALETTE[p.color]);
      e.label.innerHTML = `${p.id === leaderId ? CROWN : ''}<span>${esc(p.name)}</span>${p.id === meId ? '<em>you</em>' : ''}`;
      e.index = i;
    });
    // Stand in a gentle arc, facing the camera.
    const n = entries.size;
    for (const e of entries.values()) {
      const x = (e.index - (n - 1) / 2) * 1.25;
      e.ch.root.position.set(x, 0, -Math.abs(x) * 0.3);
      const dx = camera.position.x - x, dz = camera.position.z - e.ch.root.position.z;
      e.ch.root.rotation.y = Math.atan2(-dx, -dz);
    }
  }

  const _head = new THREE.Vector3();
  let width = 0, height = 0;

  function render(dt) {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    if (w !== width || h !== height) {
      width = w; height = h;
      camera.aspect = w / h;
      // Shift the stage right of the lobby panel on wide screens.
      const shift = w > 900 ? panelWidth / 2 : 0;
      camera.setViewOffset(w, h, -shift, 0, w, h);
      camera.updateProjectionMatrix();
    }
    for (const e of entries.values()) {
      poseCharacter(e.ch, dt, { holdGun: false, upperBody: false });
      headPosition(e.ch, _head).y += 0.42;
      placeLabel(e.label, _head, camera, w, h);
    }
    renderer.render(scene, camera);
  }

  function hideLabels(hidden) {
    labelsHidden = hidden;
    for (const e of entries.values()) e.label.hidden = hidden;
  }

  return { setPlayers, render, hideLabels };
}

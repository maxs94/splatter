// Debug scene: the player model several times, each looping one animation or one of the
// in-game combinations, on a tiled floor so the motion is easy to judge.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCharacter, poseCharacter, setAnim, funClipNames, headPosition, placeLabel } from './characters.js';
import { createRagdoll } from './ragdoll.js';

const ENTRIES = [
  { label: 'idle', clip: 'idle' },
  { label: 'run', clip: 'run' },
  { label: 'run backwards', clip: 'run', speed: -1 },
  { label: 'jump', clip: 'jump', loop: true },
  { label: 'idle + gun', clip: 'idle', gun: true },
  { label: 'run + gun', clip: 'run', gun: true, speed: 1.9 },
  { label: 'strafe left + gun', clip: 'run', gun: true, speed: 1.9, twist: 1.2 },
  { label: 'strafe right + gun', clip: 'run', gun: true, speed: 1.9, twist: -1.2 },
  { label: 'aim up/down + gun', clip: 'idle', gun: true, pitchWave: true },
];

// Ragdoll deaths: every few seconds the dummy stands up and gets shot again.
// dir is the direction the paint ball travels, height where it hits.
const RAGDOLLS = [
  { label: 'ragdoll: chest, from the front', dir: [0, 0.05, -1], height: 1.25 },
  { label: 'ragdoll: head, from the side', dir: [1, 0.1, 0], height: 1.6 },
  { label: 'ragdoll: back, while running', dir: [0, 0.1, 1], height: 1.1, run: true },
  { label: 'ragdoll: legs, from the front', dir: [0, 0, -1], height: 0.45 },
  { label: 'ragdoll: from above', dir: [0.3, -1, -0.3], height: 1.7 },
];
const RAGDOLL_CYCLE = 4.5;
const VIEWER_FLOOR = [{ min: [-60, -1, -60], max: [60, 0, 60] }];

// Readable names for the silly lobby loops (CMU clip in brackets).
const LOBBY_LABELS = {
  fun_boxing: 'shadow boxing (79_08)',
  fun_chickendance: 'chicken dance (19_15)',
  fun_dancingbear: 'dancing bear (55_12)',
  fun_drums: 'air drums (79_18)',
  fun_elephant: 'elephant (29_20)',
  fun_hop: 'hopping on one foot (49_02)',
  fun_jumpingjacks: 'jumping jacks (22_16)',
  fun_lambada: 'lambada (55_02)',
  fun_monkey: 'monkey (28_15)',
  fun_stretch: 'stretching (42_01)',
};

function tiledFloorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6a6a6e';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#5c5c60';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillRect(64, 64, 64, 64);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.strokeRect(0, 0, 64, 64);
  ctx.strokeRect(64, 64, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20); // 40m floor, 2m per texture = 1m tiles
  tex.anisotropy = 8;
  return tex;
}

export function createViewer(renderer, labelsEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b2b2e);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 10, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: tiledFloorTexture(), roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 11, 19);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.enabled = false;

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdadade, roughness: 0.6 });
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xe0503c, roughness: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.5, metalness: 0.2 });

  let items = null;
  function build() {
    // Game animations first, then the silly lobby loops.
    const entries = [
      ...ENTRIES,
      ...funClipNames().map(clip => ({ label: `lobby: ${LOBBY_LABELS[clip] || clip.slice(4)}`, clip })),
      // ragdolls last, so they end up in the front row
      ...RAGDOLLS.map(r => ({ ...r, clip: r.run ? 'run' : 'idle', gun: true, ragdoll: r })),
    ];
    const rows = Math.ceil(entries.length / 5);
    items = entries.map((def, i) => {
      const ch = createCharacter({
        bodyMat, gunShellMat: def.gun ? shellMat : null, gunDarkMat: darkMat, castShadow: true,
      });
      const col = i % 5, row = Math.floor(i / 5);
      ch.root.position.set((col - 2) * 3.2, 0, (row - (rows - 1) / 2) * 4);
      ch.root.rotation.y = Math.PI; // face the camera
      scene.add(ch.root);
      if (def.clip !== 'idle') setAnim(ch, def.clip, 0);
      const action = ch.actions[def.clip];
      if (def.loop) {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.timeScale = def.speed ?? 1;
      const label = document.createElement('div');
      label.className = 'name-label viewer-label';
      label.textContent = def.label;
      labelsEl.appendChild(label);
      const rd = def.ragdoll ? createRagdoll(ch, VIEWER_FLOOR) : null;
      return { def, ch, label, rd, t: 0, home: ch.root.position.clone() };
    });
  }

  const _head = new THREE.Vector3();
  let t = 0;

  function render(dt) {
    if (!items) build();
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    t += dt;
    controls.update();
    for (const it of items) {
      const { def, ch, label, rd } = it;
      if (rd) {
        it.t += dt;
        if (it.t > RAGDOLL_CYCLE) {
          // stand up again and play the pose for a moment
          it.t = 0;
          rd.stop();
          ch.root.position.copy(it.home);
          const a = ch.actions[def.clip];
          a.reset().play();
        }
        if (!rd.active && it.t > 0.8) {
          ch.root.updateMatrixWorld(true);
          rd.start(new THREE.Vector3(0, 0, def.run ? 3.5 : 0));
          const r = def.ragdoll;
          rd.hit(it.home.clone().setY(r.height), new THREE.Vector3(...r.dir), 8);
        }
      }
      if (rd && rd.active) {
        rd.step(dt);
        rd.apply();
      } else {
        poseCharacter(ch, dt, {
          twist: def.twist || 0,
          pitch: def.pitchWave ? Math.sin(t * 1.5) * 0.8 : 0,
          upperBody: !def.clip.startsWith('fun_'),
        });
      }
      // ragdoll labels stay where the dummy stands, so they don't cover it lying down
      if (rd) _head.copy(it.home).setY(2.3);
      else headPosition(ch, _head).y += 0.42;
      placeLabel(label, _head, camera, w, h);
    }
    renderer.render(scene, camera);
  }

  function setActive(active) {
    controls.enabled = active;
    if (items) for (const it of items) it.label.hidden = !active;
  }

  return { render, setActive };
}

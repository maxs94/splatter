// Player model (assets/character.blend, CMU mocap clips) and paintball gun.
// Shared by the game, the lobby and the animation viewer.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const RUN_CLIP_SPEED = 3.72; // m/s the run clip was captured at
export const MAX_TWIST = 1.2;       // how far the legs turn towards the move direction (rad)
const ARM_BONES = ['RightArm', 'RightForeArm', 'LeftArm', 'LeftForeArm'];
const UP = new THREE.Vector3(0, 1, 0);

export const assets = { player: null, gun: null, aimPose: {}, gunOffset: new THREE.Matrix4() };

export const assetsReady = (async () => {
  const loader = new GLTFLoader();
  const [player, gun] = await Promise.all([
    loader.loadAsync('/models/player.glb'),
    loader.loadAsync('/models/gun.glb'),
  ]);
  assets.player = player;
  assets.gun = gun;

  // Two-handed "holding the gun" arm pose, stored as a one-frame clip.
  const aim = player.animations.find(c => c.name === 'aim');
  for (const track of aim.tracks) {
    const [bone, prop] = track.name.split('.');
    if (prop === 'quaternion' && ARM_BONES.includes(bone)) {
      assets.aimPose[bone] = new THREE.Quaternion().fromArray(track.values, 0);
    }
  }

  // Where the gun sits relative to the right forearm while holding it.
  const ref = SkeletonUtils.clone(player.scene);
  for (const [name, q] of Object.entries(assets.aimPose)) ref.getObjectByName(name).quaternion.copy(q);
  ref.updateMatrixWorld(true);
  const fore = ref.getObjectByName('RightForeArm');
  const mount = ref.getObjectByName('GunMount');
  assets.gunOffset.copy(fore.matrixWorld).invert().multiply(mount.matrixWorld);
})();

// Gun mesh with separate materials for the shell and the dark metal parts.
export function cloneGun(shellMat, darkMat) {
  const gun = assets.gun.scene.clone(true);
  gun.traverse(o => {
    if (o.isMesh) o.material = o.material.name === 'GunDark' ? darkMat : shellMat;
  });
  return gun;
}

// A character instance: root is placed at the feet, root.rotation.y is the look yaw
// (players look along -Z at yaw 0).
export function createCharacter({ bodyMat, gunShellMat = null, gunDarkMat = null, castShadow = false }) {
  const root = new THREE.Group();
  const model = SkeletonUtils.clone(assets.player.scene);
  model.rotation.y = Math.PI; // the model faces +Z
  root.add(model);

  let skinned = null;
  model.traverse(o => {
    if (o.isSkinnedMesh) {
      o.material = bodyMat;
      o.frustumCulled = false;
      o.castShadow = castShadow;
      skinned = o;
    }
  });

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of assets.player.animations) {
    if (clip.name === 'aim') continue;
    const a = mixer.clipAction(clip);
    if (clip.name === 'jump') {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    actions[clip.name] = a;
  }
  actions.idle.play();

  const bones = {};
  model.traverse(o => { if (o.isBone) bones[o.name] = o; });

  let gun = null;
  if (gunShellMat) {
    gun = cloneGun(gunShellMat, gunDarkMat || gunShellMat);
    gun.traverse(o => { if (o.isMesh) o.castShadow = castShadow; });
    bones.RightForeArm.add(gun);
    assets.gunOffset.decompose(gun.position, gun.quaternion, gun.scale);
  }

  return {
    root, model, mixer, actions, skinned, bones, gun,
    state: 'idle', aim: gun ? 1 : 0, twist: 0,
  };
}

// Silly CMU clips (chicken dance, monkey, penguin...) used in the lobby.
export function funClipNames() {
  return assets.player.animations.map(c => c.name).filter(n => n.startsWith('fun_'));
}

export function setAnim(ch, state, fade = 0.2) {
  if (ch.state === state) return;
  const next = ch.actions[state];
  next.reset();
  next.setEffectiveWeight(1);
  next.play();
  ch.actions[ch.state].crossFadeTo(next, fade, false);
  ch.state = state;
}

// Picks idle / run / jump from the movement and returns the leg twist towards the
// direction of travel. Running backwards plays the run clip in reverse.
export function locomotion(ch, vel, yaw, airborne) {
  const speed = Math.hypot(vel.x, vel.z);
  if (airborne) {
    if (ch.state !== 'jump') {
      setAnim(ch, 'jump', 0.1);
      ch.actions.jump.timeScale = 1.3;
    }
    return 0;
  }
  if (speed > 0.8) {
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const fwd = -vel.x * sin - vel.z * cos;
    const side = vel.x * cos - vel.z * sin;
    const rel = Math.atan2(-side, fwd);
    const backwards = Math.abs(rel) > 1.9;
    let twist = backwards ? Math.atan2(Math.sin(rel + Math.PI), Math.cos(rel + Math.PI)) : rel;
    twist = Math.max(-MAX_TWIST, Math.min(MAX_TWIST, twist));
    setAnim(ch, 'run');
    ch.actions.run.timeScale = Math.min(2.2, speed / RUN_CLIP_SPEED) * (backwards ? -1 : 1);
    return twist;
  }
  setAnim(ch, 'idle', 0.3);
  return 0;
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _right = new THREE.Vector3();

// Rotates a bone around a world-space axis, on top of the animated pose.
function rotateBoneWorld(bone, axis, angle) {
  _q1.setFromAxisAngle(axis, angle);
  bone.parent.getWorldQuaternion(_q2);
  _q3.copy(_q2).invert().multiply(_q1).multiply(_q2);
  bone.quaternion.premultiply(_q3);
  bone.updateMatrixWorld(true);
}

// Advances the animation and layers the procedural parts on top:
// arms holding the gun, legs twisted towards the move direction, upper body aiming.
export function poseCharacter(ch, dt, { twist = 0, pitch = 0, upperBody = true, holdGun = !!ch.gun }) {
  const k = Math.min(1, 10 * dt);
  ch.twist += (twist - ch.twist) * k;
  ch.aim += ((holdGun && upperBody ? 1 : 0) - ch.aim) * Math.min(1, 8 * dt);

  ch.mixer.update(dt);
  if (ch.aim > 0.001) {
    for (const name of ARM_BONES) {
      const q = assets.aimPose[name];
      if (q && ch.bones[name]) ch.bones[name].quaternion.slerp(q, ch.aim);
    }
  }
  ch.model.rotation.y = Math.PI + ch.twist;
  ch.root.updateMatrixWorld(true);
  if (upperBody && ch.bones.Spine) {
    const yaw = ch.root.rotation.y;
    rotateBoneWorld(ch.bones.Spine, UP, -ch.twist);
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    rotateBoneWorld(ch.bones.Spine, _right, pitch * 0.5);
    if (ch.bones.Neck1) rotateBoneWorld(ch.bones.Neck1, _right, pitch * 0.4);
  }
}

export function headPosition(ch, target) {
  return (ch.bones.Head || ch.root).getWorldPosition(target);
}

// ---------------------------------------------------------------- HTML labels over 3D objects

const _proj = new THREE.Vector3();

export function placeLabel(el, world, camera, width, height) {
  _proj.copy(world).project(camera);
  const visible = _proj.z < 1 && Math.abs(_proj.x) < 1.2 && Math.abs(_proj.y) < 1.2;
  el.style.display = visible ? '' : 'none';
  if (!visible) return;
  const x = (_proj.x * 0.5 + 0.5) * width;
  const y = (-_proj.y * 0.5 + 0.5) * height;
  el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
}

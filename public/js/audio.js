// Sound effects: sampled sounds with 3D positioning relative to the listener, and a
// master volume that is remembered per browser.

const FILES = {
  shoot: '/sounds/shoot.mp3',
  splat: '/sounds/splatter.mp3',
  footstep: '/sounds/footstep.mp3',
  // Announcer (see SPREES and MULTI_KILLS in shared/game.js, and headshots).
  ...Object.fromEntries(['firstblood', 'dominating', 'rampage', 'killingspree', 'monsterkill', 'unstoppable', 'ultrakill',
    'godlike', 'wickedsick', 'ludicrouskill', 'holyshit', 'tripplekill', 'headshot'].map(k => [k, `/sounds/${k}.mp3`])),
};

let ctx = null;
let master = null;
const buffers = {};
let volume = 0.8;
try {
  const v = parseFloat(localStorage.getItem('splatter-volume'));
  if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
} catch {}

export function initAudio() {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      for (const [key, url] of Object.entries(FILES)) {
        fetch(url)
          .then(r => r.arrayBuffer())
          .then(buf => ctx.decodeAudioData(buf))
          .then(decoded => { buffers[key] = decoded; })
          .catch(() => {});
      }
    }
    ctx.resume();
  } catch {
    ctx = null;
  }
}

export const getVolume = () => volume;

export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  if (master) master.gain.value = volume;
  try { localStorage.setItem('splatter-volume', String(volume)); } catch {}
}

// Keeps the listener at the camera so positional sounds pan and fade correctly.
export function updateListener(camera) {
  if (!ctx) return;
  const l = ctx.listener;
  const e = camera.matrixWorld.elements;
  const p = { x: e[12], y: e[13], z: e[14] };
  // camera looks down its local -Z, up is local +Y
  const fx = -e[8], fy = -e[9], fz = -e[10], ux = e[4], uy = e[5], uz = e[6];
  if (l.positionX) {
    const t = ctx.currentTime;
    l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
    l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(fy, t); l.forwardZ.setValueAtTime(fz, t);
    l.upX.setValueAtTime(ux, t); l.upY.setValueAtTime(uy, t); l.upZ.setValueAtTime(uz, t);
  } else {
    l.setPosition(p.x, p.y, p.z);
    l.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

// Plays a sample. With `pos` ([x, y, z]) it is placed in the world and gets quieter with
// distance, `rate` pitches it. Returns false when the sample isn't loaded (yet).
export function play(key, { pos = null, vol = 1, jitter = 0.08, rate = 1 } = {}) {
  const buf = buffers[key];
  if (!ctx || !buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g);
  if (pos) {
    const panner = new PannerNode(ctx, {
      panningModel: 'equalpower', distanceModel: 'inverse',
      refDistance: 3, rolloffFactor: 1.3, maxDistance: 120,
      positionX: pos[0], positionY: pos[1], positionZ: pos[2],
    });
    g.connect(panner).connect(master);
  } else {
    g.connect(master);
  }
  src.start();
  return true;
}

// Small synthesized UI sounds (hit markers etc.), not positional.
export function tone(f0, f1, dur, type, vol) {
  if (!ctx || vol < 0.005) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

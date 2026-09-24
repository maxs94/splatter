// Navigation graph generated from the level: one node per 2m cell at standing height,
// with an edge wherever a simulated player can actually walk (or drop) to the neighbor.

import { CONFIG as C, LEVEL, movePlayer } from '../shared/game.js';

const CELL = 2;
const MAX_STAND_HEIGHT = 4; // skips walls and pillar tops

function canWalk(a, b) {
  const s = { p: a.slice(), v: [0, 0, 0], onGround: true };
  const dt = 1 / 30;
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / C.MOVE_SPEED / dt) * 3 + 20;
  for (let k = 0; k < steps; k++) {
    const dx = b[0] - s.p[0], dz = b[2] - s.p[2];
    if (Math.hypot(dx, dz) < 0.35 && s.onGround) return Math.abs(s.p[1] - b[1]) < 0.5;
    movePlayer(s, { f: 1, r: 0, jump: false, yaw: Math.atan2(-dx, -dz) }, dt);
  }
  return false;
}

// Tiny binary heap of [priority, value].
function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}
function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

export class NavGraph {
  constructor() {
    const t0 = Date.now();
    const H = LEVEL.half, r = C.PLAYER_RADIUS;
    const nodes = [];
    const grid = new Map();

    for (let x = -H + CELL / 2; x < H; x += CELL) {
      for (let z = -H + CELL / 2; z < H; z += CELL) {
        let y = -Infinity;
        for (const b of LEVEL.boxes) {
          if (x + r > b.min[0] && x - r < b.max[0] && z + r > b.min[2] && z - r < b.max[2]) y = Math.max(y, b.max[1]);
        }
        if (y === -Infinity || y > MAX_STAND_HEIGHT) continue;
        grid.set(`${x},${z}`, nodes.length);
        nodes.push({ i: nodes.length, p: [x, y, z], edges: [], ok: false });
      }
    }

    let edgeCount = 0;
    for (const n of nodes) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const j = grid.get(`${n.p[0] + dx * CELL},${n.p[2] + dz * CELL}`);
          if (j === undefined) continue;
          const m = nodes[j];
          if (canWalk(n.p, m.p)) {
            n.edges.push({ to: j, cost: Math.hypot(m.p[0] - n.p[0], (m.p[1] - n.p[1]) * 2, m.p[2] - n.p[2]) });
            edgeCount++;
          }
        }
      }
    }

    // Keep only nodes reachable from the main floor.
    this.nodes = nodes;
    const start = this.nearest(LEVEL.spawns[0], true);
    const queue = [start];
    start.ok = true;
    while (queue.length) {
      const n = queue.shift();
      for (const e of n.edges) {
        if (!nodes[e.to].ok) { nodes[e.to].ok = true; queue.push(nodes[e.to]); }
      }
    }
    this.okNodes = nodes.filter(n => n.ok);
    console.log(`Nav graph: ${this.okNodes.length}/${nodes.length} nodes, ${edgeCount} edges in ${Date.now() - t0}ms`);
  }

  nearest(pos, any = false) {
    let best = null, bestD = Infinity;
    for (const n of any ? this.nodes : this.okNodes) {
      const dx = n.p[0] - pos[0], dy = (n.p[1] - pos[1]) * 3, dz = n.p[2] - pos[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  randomNode() {
    return this.okNodes[Math.floor(Math.random() * this.okNodes.length)];
  }

  // A* from the node nearest `from` to the node nearest `to`. Returns positions or null.
  findPath(from, to) {
    const s = this.nearest(from), g = this.nearest(to);
    if (!s || !g) return null;
    const N = this.nodes.length;
    const cost = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const h = n => Math.hypot(n.p[0] - g.p[0], n.p[1] - g.p[1], n.p[2] - g.p[2]);
    const open = [];
    cost[s.i] = 0;
    heapPush(open, [h(s), s.i]);
    while (open.length) {
      const [, i] = heapPop(open);
      if (closed[i]) continue;
      if (i === g.i) break;
      closed[i] = 1;
      for (const e of this.nodes[i].edges) {
        const c = cost[i] + e.cost;
        if (c < cost[e.to]) {
          cost[e.to] = c;
          came[e.to] = i;
          heapPush(open, [c + h(this.nodes[e.to]), e.to]);
        }
      }
    }
    if (cost[g.i] === Infinity) return null;
    const path = [];
    for (let i = g.i; i !== -1; i = came[i]) path.push(this.nodes[i].p);
    return path.reverse();
  }
}

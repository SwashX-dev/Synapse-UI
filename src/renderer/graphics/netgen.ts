/**
 * Procedural network generation (runs in a Web Worker; pure and seedable).
 *
 * Layouts place nodes; algorithms wire them:
 *   knn          k nearest neighbours (spatial hash grid)
 *   small-world  Watts–Strogatz: local kNN lattice with probability-β rewiring to long-range chords
 *   scale-free   Barabási–Albert preferential attachment with a spatial distance bias (hubs emerge)
 *   modular      dense communities with sparse inter-community bridges
 *   geometric    random geometric graph (all pairs within radius r tuned for mean degree k)
 *   great-circle kNN rendered as arcs hugging the sphere surface
 */
import { Rng } from '../../shared/random';

export type Layout = 'sphere' | 'galaxy' | 'genesis' | 'constellation' | 'singularity' | 'lattice';
export type Algorithm = 'knn' | 'small-world' | 'scale-free' | 'modular' | 'geometric' | 'great-circle';

export interface NetGenInput {
  nodes: number;
  degree: number;
  algorithm: Algorithm;
  layout: Layout;
  shell: number;
  clustering: number;
  seed: number;
  /** Rewiring probability for small-world. */
  beta?: number;
}

export interface Network {
  n: number;
  positions: Float32Array;
  edges: Uint32Array;
  lengths: Float32Array;
  order: Float32Array;
  degree: Uint16Array;
  cluster: Uint16Array;
  hubs: Uint32Array;
  arcs: boolean;
  /** For genesis: per-node creation order (0..1). */
  nodeOrder: Float32Array;
  ms: number;
}

class Grid {
  cells = new Map<number, number[]>();
  constructor(private pos: Float32Array, private size: number, private lo = -1.6) {}
  key(x: number, y: number, z: number): number {
    const g = this.size;
    const s = 3.2 / g;
    const ix = Math.max(0, Math.min(g - 1, Math.floor((x - this.lo) / s)));
    const iy = Math.max(0, Math.min(g - 1, Math.floor((y - this.lo) / s)));
    const iz = Math.max(0, Math.min(g - 1, Math.floor((z - this.lo) / s)));
    return (ix * g + iy) * g + iz;
  }
  cellCoords(x: number, y: number, z: number): [number, number, number] {
    const g = this.size;
    const s = 3.2 / g;
    return [Math.max(0, Math.min(g - 1, Math.floor((x - this.lo) / s))), Math.max(0, Math.min(g - 1, Math.floor((y - this.lo) / s))), Math.max(0, Math.min(g - 1, Math.floor((z - this.lo) / s)))];
  }
  insert(i: number): void {
    const p = this.pos;
    const k = this.key(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    let c = this.cells.get(k);
    if (!c) { c = []; this.cells.set(k, c); }
    c.push(i);
  }
  /** k nearest neighbours of node i (excluding i), searching expanding shells of cells. */
  knn(i: number, k: number, out: number[], maxRing = 4): void {
    out.length = 0;
    const p = this.pos;
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const [cx, cy, cz] = this.cellCoords(x, y, z);
    const g = this.size;
    const best: { j: number; d: number }[] = [];
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
        const ix = cx + dx, iy = cy + dy, iz = cz + dz;
        if (ix < 0 || iy < 0 || iz < 0 || ix >= g || iy >= g || iz >= g) continue;
        const cell = this.cells.get((ix * g + iy) * g + iz);
        if (!cell) continue;
        for (const j of cell) {
          if (j === i) continue;
          const ddx = p[j * 3] - x, ddy = p[j * 3 + 1] - y, ddz = p[j * 3 + 2] - z;
          const d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (best.length < k) {
            best.push({ j, d });
            best.sort((a, b2) => a.d - b2.d);
          } else if (d < best[k - 1].d) {
            best[k - 1] = { j, d };
            best.sort((a, b2) => a.d - b2.d);
          }
        }
      }
      const s = 3.2 / g;
      if (best.length >= k && Math.sqrt(best[best.length - 1].d) < ring * s) break;
    }
    for (const b2 of best) out.push(b2.j);
  }
  within(i: number, r: number, out: number[], cap: number): void {
    out.length = 0;
    const p = this.pos;
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const g = this.size;
    const s = 3.2 / g;
    const ring = Math.ceil(r / s);
    const [cx, cy, cz] = this.cellCoords(x, y, z);
    const r2 = r * r;
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
      const ix = cx + dx, iy = cy + dy, iz = cz + dz;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= g || iy >= g || iz >= g) continue;
      const cell = this.cells.get((ix * g + iy) * g + iz);
      if (!cell) continue;
      for (const j of cell) {
        if (j <= i) continue;
        const ddx = p[j * 3] - x, ddy = p[j * 3 + 1] - y, ddz = p[j * 3 + 2] - z;
        if (ddx * ddx + ddy * ddy + ddz * ddz < r2) {
          out.push(j);
          if (out.length >= cap) return;
        }
      }
    }
  }
}

function place(inp: NetGenInput, rng: Rng): { pos: Float32Array; cluster: Uint16Array; nodeOrder: Float32Array; parent: Int32Array | null } {
  const n = inp.nodes;
  const pos = new Float32Array(n * 3);
  const cluster = new Uint16Array(n);
  const nodeOrder = new Float32Array(n);
  let parent: Int32Array | null = null;
  const v: [number, number, number] = [0, 0, 0];
  const nClusters = Math.max(4, Math.round(Math.sqrt(n) / 6));
  const centers: [number, number, number][] = Array.from({ length: nClusters }, () => rng.onSphere([0, 0, 0]));
  switch (inp.layout) {
    case 'sphere': {
      for (let i = 0; i < n; i++) {
        let c = 0;
        if (rng.next() < inp.clustering) {
          c = rng.int(0, nClusters);
          const ctr = centers[c];
          const spread = 0.22 + rng.next() * 0.12;
          v[0] = ctr[0] + rng.gauss() * spread; v[1] = ctr[1] + rng.gauss() * spread; v[2] = ctr[2] + rng.gauss() * spread;
          const l = Math.hypot(v[0], v[1], v[2]) || 1;
          v[0] /= l; v[1] /= l; v[2] /= l;
        } else {
          rng.onSphere(v);
          let bestD = 9;
          centers.forEach((ctr, ci) => { const d = (ctr[0] - v[0]) ** 2 + (ctr[1] - v[1]) ** 2 + (ctr[2] - v[2]) ** 2; if (d < bestD) { bestD = d; c = ci; } });
        }
        const u = rng.next();
        const r = 1 - inp.shell * (1 - Math.cbrt(u)) + (rng.next() - 0.5) * 0.035;
        pos[i * 3] = v[0] * r; pos[i * 3 + 1] = v[1] * r; pos[i * 3 + 2] = v[2] * r;
        cluster[i] = c;
        nodeOrder[i] = i / n;
      }
      break;
    }
    case 'galaxy': {
      const arms = 2 + (inp.seed % 3);
      for (let i = 0; i < n; i++) {
        const core = rng.next() < 0.18;
        const r = core ? Math.abs(rng.gauss()) * 0.12 : 0.1 + Math.pow(rng.next(), 0.75) * 0.95;
        const arm = rng.int(0, arms);
        const twist = 3.4;
        const a = (arm / arms) * Math.PI * 2 + r * twist + rng.gauss() * (0.16 + 0.1 * (1 - inp.clustering)) * (core ? 4 : 1);
        const y = rng.gauss() * 0.05 * (1.2 - r) * (core ? 2 : 1);
        pos[i * 3] = Math.cos(a) * r * 1.1; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r * 1.1;
        cluster[i] = core ? 0 : 1 + arm;
        nodeOrder[i] = r;
      }
      break;
    }
    case 'genesis': {
      parent = new Int32Array(n).fill(-1);
      const dirs = new Float32Array(n * 3);
      const seeds = Math.max(2, Math.round(3 + inp.clustering * 6));
      let count = 0;
      for (let s = 0; s < seeds && count < n; s++, count++) {
        rng.onSphere(v);
        pos[count * 3] = v[0] * 0.25; pos[count * 3 + 1] = v[1] * 0.25; pos[count * 3 + 2] = v[2] * 0.25;
        dirs[count * 3] = v[0]; dirs[count * 3 + 1] = v[1]; dirs[count * 3 + 2] = v[2];
        cluster[count] = s;
      }
      const tips: number[] = Array.from({ length: count }, (_, i) => i);
      while (count < n) {
        const ti = tips.length > 1 && rng.next() < 0.7 ? tips.length - 1 - Math.floor(Math.pow(rng.next(), 2) * Math.min(tips.length, 64)) : rng.int(0, tips.length);
        const p = tips[Math.max(0, ti)];
        const step = 0.035 + rng.next() * 0.03;
        let dx = dirs[p * 3] + rng.gauss() * 0.45, dy = dirs[p * 3 + 1] + rng.gauss() * 0.45, dz = dirs[p * 3 + 2] + rng.gauss() * 0.45;
        const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2];
        const rr = Math.hypot(px, py, pz);
        if (rr > 1.1) { dx -= px * 0.6; dy -= py * 0.6; dz -= pz * 0.6; }
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
        const i = count++;
        pos[i * 3] = px + dx * step; pos[i * 3 + 1] = py + dy * step; pos[i * 3 + 2] = pz + dz * step;
        dirs[i * 3] = dx; dirs[i * 3 + 1] = dy; dirs[i * 3 + 2] = dz;
        parent[i] = p;
        cluster[i] = cluster[p];
        tips.push(i);
        if (rng.next() < 0.08 && tips.length > 8) tips.splice(rng.int(0, tips.length - 4), 1);
      }
      for (let i = 0; i < n; i++) nodeOrder[i] = i / n;
      break;
    }
    case 'constellation': {
      for (let i = 0; i < n; i++) {
        rng.onSphere(v);
        const r = Math.pow(rng.next(), 0.5) * 1.05;
        pos[i * 3] = v[0] * r * 1.3; pos[i * 3 + 1] = v[1] * r * 0.55; pos[i * 3 + 2] = v[2] * r * 1.3;
        cluster[i] = rng.int(0, nClusters);
        nodeOrder[i] = rng.next();
      }
      break;
    }
    case 'singularity': {
      for (let i = 0; i < n; i++) {
        rng.onSphere(v);
        const r = 0.04 + Math.pow(rng.next(), 2.6) * 1.05;
        pos[i * 3] = v[0] * r; pos[i * 3 + 1] = v[1] * r; pos[i * 3 + 2] = v[2] * r;
        cluster[i] = Math.min(65535, Math.floor(r * 8));
        nodeOrder[i] = r;
      }
      break;
    }
    case 'lattice': {
      const side = Math.max(3, Math.round(Math.cbrt(n)));
      let i = 0;
      for (let x = 0; x < side && i < n; x++) for (let y = 0; y < side && i < n; y++) for (let z = 0; z < side && i < n; z++, i++) {
        const j = 0.18 * inp.clustering;
        pos[i * 3] = ((x / (side - 1)) * 2 - 1) * 1.4 + rng.gauss() * j * 0.1;
        pos[i * 3 + 1] = ((y / (side - 1)) * 2 - 1) * 1.4 + rng.gauss() * j * 0.1;
        pos[i * 3 + 2] = ((z / (side - 1)) * 2 - 1) * 1.4 + rng.gauss() * j * 0.1;
        cluster[i] = (x + y + z) % 4;
        nodeOrder[i] = (x + y + z) / (3 * side);
      }
      for (; i < n; i++) { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0; }
      break;
    }
  }
  return { pos, cluster, nodeOrder, parent };
}

export function generateNetwork(inp: NetGenInput): Network {
  const t0 = performance.now();
  const n = Math.max(16, Math.min(120_000, Math.floor(inp.nodes)));
  inp = { ...inp, nodes: n };
  const rng = new Rng(inp.seed);
  const { pos, cluster, nodeOrder, parent } = place(inp, rng);
  const k = Math.max(1, Math.min(24, Math.round(inp.degree)));
  const gsize = Math.max(4, Math.min(96, Math.round(Math.cbrt(n / 3) * 2)));
  const grid = new Grid(pos, gsize);
  for (let i = 0; i < n; i++) grid.insert(i);
  const edgeSet = new Set<number>();
  const edgesA: number[] = [];
  const edgesB: number[] = [];
  const deg = new Uint16Array(n);
  const add = (a: number, b2: number) => {
    if (a === b2) return false;
    const lo = Math.min(a, b2), hi = Math.max(a, b2);
    const key = lo * n + hi;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    edgesA.push(lo);
    edgesB.push(hi);
    if (deg[lo] < 65535) deg[lo]++;
    if (deg[hi] < 65535) deg[hi]++;
    return true;
  };
  const nb: number[] = [];
  const algo = inp.algorithm;

  if (parent) for (let i = 0; i < n; i++) if (parent[i] >= 0) add(i, parent[i]);

  if (algo === 'knn' || algo === 'great-circle' || (parent && algo !== 'scale-free')) {
    const kk = parent ? Math.max(1, Math.round(k / 4)) : Math.max(1, Math.ceil(k / 2));
    for (let i = 0; i < n; i++) {
      grid.knn(i, kk, nb);
      for (const j of nb) add(i, j);
    }
  } else if (algo === 'small-world') {
    const beta = inp.beta ?? 0.06;
    const half = Math.max(1, Math.ceil(k / 2));
    for (let i = 0; i < n; i++) {
      grid.knn(i, half, nb);
      for (const j of nb) {
        if (rng.next() < beta) add(i, rng.int(0, n));
        else add(i, j);
      }
    }
  } else if (algo === 'scale-free') {
    const m = Math.max(1, Math.round(k / 2));
    const ends: number[] = [];
    const sigma = 0.55;
    for (let i = 0; i < Math.min(n, m + 1); i++) for (let j = 0; j < i; j++) { add(i, j); ends.push(i, j); }
    for (let i = m + 1; i < n; i++) {
      let made = 0;
      for (let tries = 0; made < m && tries < m * 12; tries++) {
        const cand = ends.length && rng.next() < 0.9 ? ends[rng.int(0, ends.length)] : rng.int(0, i);
        const d = Math.hypot(pos[i * 3] - pos[cand * 3], pos[i * 3 + 1] - pos[cand * 3 + 1], pos[i * 3 + 2] - pos[cand * 3 + 2]);
        if (rng.next() > Math.exp(-d / sigma)) continue;
        if (add(i, cand)) { ends.push(i, cand); made++; }
      }
    }
  } else if (algo === 'modular') {
    const half = Math.max(1, Math.ceil(k / 2));
    for (let i = 0; i < n; i++) {
      grid.knn(i, half + 2, nb);
      let c = 0;
      for (const j of nb) {
        if (cluster[j] === cluster[i] || rng.next() < 0.08) { add(i, j); if (++c >= half) break; }
      }
    }
    // Bridges between community hubs.
    const byCluster = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { let l = byCluster.get(cluster[i]); if (!l) byCluster.set(cluster[i], (l = [])); l.push(i); }
    const groups = [...byCluster.values()];
    for (let b2 = 0; b2 < groups.length * 6; b2++) {
      const g1 = groups[rng.int(0, groups.length)], g2 = groups[rng.int(0, groups.length)];
      if (g1 !== g2) add(g1[rng.int(0, g1.length)], g2[rng.int(0, g2.length)]);
    }
  } else if (algo === 'geometric') {
    const r = 2 * Math.sqrt(k / n) * (1 + inp.shell * 0.9);
    for (let i = 0; i < n; i++) {
      grid.within(i, r, nb, k * 3);
      for (const j of nb) add(i, j);
    }
  }

  const E = edgesA.length;
  const edges = new Uint32Array(E * 2);
  const lengths = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const a = edgesA[e], b2 = edgesB[e];
    edges[e * 2] = a;
    edges[e * 2 + 1] = b2;
    lengths[e] = Math.hypot(pos[a * 3] - pos[b2 * 3], pos[a * 3 + 1] - pos[b2 * 3 + 1], pos[a * 3 + 2] - pos[b2 * 3 + 2]) || 1e-4;
  }

  // Growth order: BFS from a random root (genesis: creation order), normalised to 0..1.
  const order = new Float32Array(E);
  if (parent) {
    for (let e = 0; e < E; e++) order[e] = Math.max(nodeOrder[edges[e * 2]], nodeOrder[edges[e * 2 + 1]]);
  } else {
    const offs = new Uint32Array(n + 1);
    for (let e = 0; e < E; e++) { offs[edges[e * 2] + 1]++; offs[edges[e * 2 + 1] + 1]++; }
    for (let i = 0; i < n; i++) offs[i + 1] += offs[i];
    const adj = new Uint32Array(E * 2);
    const fill = offs.slice(0, n);
    for (let e = 0; e < E; e++) { const a = edges[e * 2], b2 = edges[e * 2 + 1]; adj[fill[a]++] = b2; adj[fill[b2]++] = a; }
    const dist = new Int32Array(n).fill(-1);
    const queue = new Uint32Array(n);
    let qh = 0, qt = 0, maxD = 1;
    for (let start = rng.int(0, n), seen = 0; seen < n; ) {
      if (dist[start] < 0) {
        dist[start] = 0;
        queue[qt++] = start;
        while (qh < qt) {
          const u = queue[qh++];
          seen++;
          for (let q = offs[u]; q < offs[u + 1]; q++) {
            const w = adj[q];
            if (dist[w] < 0) { dist[w] = dist[u] + 1; maxD = Math.max(maxD, dist[w]); queue[qt++] = w; }
          }
        }
      }
      if (seen < n) {
        start = dist.indexOf(-1);
        if (start < 0) break;
      }
    }
    for (let e = 0; e < E; e++) order[e] = (Math.max(dist[edges[e * 2]], dist[edges[e * 2 + 1]]) + rng.next() * 0.8) / (maxD + 1);
  }

  const hubIdx = Array.from({ length: n }, (_, i) => i).sort((a, b2) => deg[b2] - deg[a]).slice(0, 12);
  return { n, positions: pos, edges, lengths, order, degree: deg, cluster, hubs: Uint32Array.from(hubIdx), arcs: algo === 'great-circle', nodeOrder, ms: performance.now() - t0 };
}

/** Run generation in a worker when available (keeps the UI responsive), else inline. */
export function generateAsync(inp: NetGenInput): Promise<Network> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./workers/netgen.worker.js', document.baseURI), { type: 'module' });
    } catch {
      resolve(generateNetwork(inp));
      return;
    }
    const timer = setTimeout(() => {
      worker?.terminate();
      resolve(generateNetwork(inp));
    }, 20000);
    worker.onmessage = (e: MessageEvent<Network>) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(e.data);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(generateNetwork(inp));
    };
    worker.postMessage(inp);
  });
}

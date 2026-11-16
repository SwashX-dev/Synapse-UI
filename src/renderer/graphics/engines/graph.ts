/**
 * Network engine for non-spherical graph visualizations:
 *   genesis       growing arbours (regrow with a new seed each cycle)
 *   galaxy        spiral-arm clusters
 *   evolution     force-directed graph rewired by preferential attachment / triadic closure
 *   constellation sparse starfield of connected data points
 *   topology      LIVE network: host → subnets → peers from active connections
 *   singularity   dense, centrally concentrated breathing network
 *   lattice       vast connected lattice to fly through
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num, str } from '../types';
import { generateAsync, generateNetwork, type Network } from '../netgen';
import { NetworkMesh, NetworkSim, type SimParams } from '../network';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';
import type { ConnData, NetData } from '../../core/monitor';

type Mode = 'genesis' | 'galaxy' | 'evolution' | 'constellation' | 'topology' | 'singularity' | 'lattice';

const NODES: Record<Mode, number[]> = {
  genesis: [1800, 4000, 8000, 14000],
  galaxy: [4000, 10000, 20000, 36000],
  evolution: [300, 600, 1000, 1600],
  constellation: [900, 2000, 4000, 7000],
  topology: [0, 0, 0, 0],
  singularity: [3000, 8000, 16000, 28000],
  lattice: [1000, 2744, 5832, 10648],
};

export const neuralGraph: EngineDef = {
  id: 'neural-graph',
  name: 'Network Engine',
  description: 'Procedural and live graphs: growth, galaxies, evolving topologies, real network connections.',
  artistic: true,
  science: 'Graph algorithms (BFS growth order, preferential attachment, triadic closure, force-directed layout with spring/repulsion forces) are implemented faithfully; visual activity is artistic. Topology mode uses real connection data from the monitoring service.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic', 'tracking'],
  defaultCamera: 'orbital',
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'genesis', group: 'Structure', rebuild: true, options: [
      { value: 'genesis', label: 'Neural genesis' }, { value: 'galaxy', label: 'Neural galaxy' }, { value: 'evolution', label: 'Network evolution' }, { value: 'constellation', label: 'Data constellation' },
      { value: 'topology', label: 'Network topology (live)' }, { value: 'singularity', label: 'Data singularity' }, { value: 'lattice', label: 'Wireframe universe' }] },
    { key: 'nodes', label: 'Nodes (0 = by quality)', type: 'int', default: 0, min: 0, max: 60000, step: 100, group: 'Structure', rebuild: true },
    { key: 'degree', label: 'Connection density', type: 'int', default: 4, min: 1, max: 12, group: 'Structure', rebuild: true },
    { key: 'clustering', label: 'Clustering', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Structure', rebuild: true },
    { key: 'growthCycle', label: 'Growth cycle (s)', type: 'number', default: 26, min: 4, max: 120, step: 1, group: 'Structure' },
    { key: 'rewire', label: 'Rewiring rate', type: 'number', default: 0.6, min: 0, max: 5, step: 0.05, group: 'Structure' },
    { key: 'rule', label: 'Evolution rule', type: 'select', default: 'mixed', group: 'Structure', options: [{ value: 'preferential', label: 'Preferential attachment' }, { value: 'triadic', label: 'Triadic closure' }, { value: 'mixed', label: 'Mixed' }, { value: 'random', label: 'Random' }] },
    { key: 'activity', label: 'Activity', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Signals' },
    { key: 'pulseSpeed', label: 'Impulse speed', type: 'number', default: 0.6, min: 0.05, max: 3, step: 0.01, group: 'Signals' },
    { key: 'propagation', label: 'Propagation', type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'trails', label: 'Impulse trails', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'lineAlpha', label: 'Strand brightness', type: 'number', default: 0.09, min: 0, max: 0.6, step: 0.005, group: 'Look' },
    { key: 'nodeSize', label: 'Node size', type: 'number', default: 1.3, min: 0, max: 5, step: 0.05, group: 'Look' },
    { key: 'curvature', label: 'Curvature', type: 'number', default: 0.25, min: 0, max: 1.5, step: 0.01, group: 'Look' },
    { key: 'rotation', label: 'Rotation', type: 'number', default: 0.4, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'labels', label: 'Labels', type: 'bool', default: true, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Rendering' },
    { key: 'speed', label: 'Animation speed', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Rendering' },
  ],
  async create(ctx) {
    const mode = str(ctx.params, 'mode', 'genesis') as Mode;
    const q = ctx.quality;
    const nodes = num(ctx.params, 'nodes', 0) || NODES[mode][q] || 2000;
    if (mode === 'topology') return new GraphEngine(topologyNetwork(null), mode, ctx.seed, ctx.params, ctx.colors, q);
    const layout = mode === 'evolution' ? 'constellation' : mode;
    const algorithm = mode === 'singularity' ? 'scale-free' : 'knn';
    const degree = mode === 'lattice' ? 6 : mode === 'constellation' ? 2 : mode === 'evolution' ? 3 : num(ctx.params, 'degree', 4);
    const net = await generateAsync({ nodes, degree, algorithm, layout, shell: 0, clustering: num(ctx.params, 'clustering', 0.5), seed: ctx.seed });
    return new GraphEngine(net, mode, ctx.seed, ctx.params, ctx.colors, q);
  },
};

class GraphEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  radius = 1.2;
  private root = new THREE.Group();
  private mesh: NetworkMesh;
  private sim: NetworkSim;
  private colors: VizColors;
  private params: Params;
  private growth = 0;
  private cycleT = 0;
  private regenerating = false;
  private seed: number;
  private rng: Rng;
  private vel: Float32Array | null = null;
  private pos: Float32Array;
  private rewireAcc = 0;
  private topoKey = '';
  private topoCheck = 0;
  private topoLabels: { node: number; text: string; sub?: string }[] = [];
  private liveRate = 0;

  constructor(private net: Network, private mode: Mode, seed: number, params: Params, colors: VizColors, readonly quality: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x9e37);
    this.params = params;
    this.colors = colors;
    this.scene.add(this.root);
    this.mesh = this.makeMesh(net);
    this.root.add(this.mesh.group);
    this.sim = new NetworkSim(net, this.mesh, seed);
    this.pos = net.positions.slice();
    if (mode === 'evolution') this.vel = new Float32Array(net.n * 3);
    if (mode === 'lattice') this.radius = 1.4;
    if (mode === 'galaxy') { this.radius = 1.0; this.root.rotation.x = 0.85; }
    this.growth = mode === 'genesis' ? 0 : 1;
    this.apply(params);
  }

  private makeMesh(net: Network): NetworkMesh {
    const c = this.colors;
    return new NetworkMesh(net, { segments: this.mode === 'lattice' || this.mode === 'topology' ? 2 : 4, colors: { line: c.neural.clone(), pulse: c.pulse.clone(), node: c.neural.clone().lerp(new THREE.Color(1, 1, 1), 0.3), highlight: c.accent.clone() } });
  }

  private apply(p: Params): void {
    const u = this.mesh.edgeUniforms;
    u.uPulseSpeed.value = num(p, 'pulseSpeed', 0.6);
    u.uTrail.value = num(p, 'trails', 0.5);
    u.uLineAlpha.value = num(p, 'lineAlpha', 0.09) * ({ lattice: 0.25, galaxy: 0.22, singularity: 0.045, genesis: 0.9, constellation: 1, evolution: 1, topology: 1.4 } as Record<Mode, number>)[this.mode];
    u.uCurv.value = num(p, 'curvature', 0.25);
    u.uBreath.value = this.mode === 'constellation' ? 0.5 : 0.15;
    u.uPulseWidth.value = this.mode === 'lattice' ? 0.05 : 0.03;
    this.mesh.nodeUniforms.uNodeSize.value = num(p, 'nodeSize', 1.3) * (this.mode === 'constellation' || this.mode === 'topology' ? 0.03 : 0.014);
    this.mesh.nodeUniforms.uNodeAlpha.value = this.mode === 'constellation' || this.mode === 'topology' ? 0.8 : this.mode === 'singularity' || this.mode === 'galaxy' ? 0.12 : 0.3;
    u.uPulseGain.value = this.mode === 'singularity' || this.mode === 'galaxy' ? 0.5 : 1;
  }

  setParam(_k: string, _v: unknown, p: Params): boolean {
    this.params = p;
    this.apply(p);
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    this.mesh.setColors({ line: c.neural, pulse: c.pulse, node: c.neural.clone().lerp(new THREE.Color(1, 1, 1), 0.3), highlight: c.accent });
  }

  private swap(net: Network): void {
    this.root.remove(this.mesh.group);
    this.mesh.dispose();
    this.net = net;
    this.mesh = this.makeMesh(net);
    this.root.add(this.mesh.group);
    this.sim = new NetworkSim(net, this.mesh, this.seed);
    this.pos = net.positions.slice();
    this.apply(this.params);
  }

  update(dt: number, t: number, p: Params, input: FrameInput, camera: THREE.Camera): void {
    this.params = p;
    const act = num(p, 'activity', 1);
    const sp: SimParams = { rate: 0.012 * act, propagation: num(p, 'propagation', 0.55), speed: num(p, 'pulseSpeed', 0.6), refractory: 1.2, burst: 0.5 * act, wave: 0 };
    switch (this.mode) {
      case 'genesis': {
        const cycle = num(p, 'growthCycle', 26);
        this.cycleT += dt;
        this.growth = Math.min(1, this.cycleT / (cycle * 0.7));
        const fade = this.cycleT > cycle * 0.9 ? Math.max(0, 1 - (this.cycleT - cycle * 0.9) / (cycle * 0.1)) : 1;
        this.mesh.edgeUniforms.uOpacity.value = fade * num(p, 'layerOpacity', 1);
        if (this.cycleT >= cycle && !this.regenerating) {
          this.regenerating = true;
          this.seed++;
          void generateAsync({ nodes: this.net.n, degree: 4, algorithm: 'knn', layout: 'genesis', shell: 0, clustering: num(p, 'clustering', 0.5), seed: this.seed }).then((net) => {
            this.swap(net);
            this.cycleT = 0;
            this.growth = 0;
            this.regenerating = false;
          });
        }
        // Growth tips fire as they appear.
        const n = this.net.n;
        const tip = Math.floor(this.growth * n);
        for (let k = 0; k < 6; k++) { const i = Math.max(0, tip - 1 - this.rng.int(0, 40)); if (i < n) this.sim.fire(i, t, sp); }
        break;
      }
      case 'evolution':
        this.evolve(dt, t, p, sp);
        break;
      case 'topology':
        this.topology(dt, t, input, sp);
        break;
      case 'singularity': {
        const s = 1 + 0.14 * Math.sin(t * 0.55) + 0.04 * Math.sin(t * 1.7);
        this.root.scale.setScalar(s);
        break;
      }
      default:
        break;
    }
    this.mesh.edgeUniforms.uGrowth.value = this.growth;
    if (this.mode !== 'genesis') this.mesh.edgeUniforms.uOpacity.value = num(p, 'layerOpacity', 1);
    if (this.mode !== 'topology') this.sim.step(t, dt, sp);
    if (this.mode === 'galaxy') this.root.rotateY(dt * 0.036 * num(p, 'rotation', 0.4));
    else this.root.rotation.y += dt * 0.06 * num(p, 'rotation', 0.4);
    this.root.updateMatrixWorld();
    const d = camera.position.length();
    this.mesh.edgeUniforms.uFogNear.value = Math.max(0.01, d - this.radius);
    this.mesh.edgeUniforms.uFogFar.value = d + this.radius * 1.2;
    this.mesh.upload(t, input.height, (camera as THREE.PerspectiveCamera).fov ?? 50);
  }

  /** Force-directed layout + rewiring. */
  private evolve(dt: number, t: number, p: Params, sp: SimParams): void {
    const n = this.net.n;
    const pos = this.pos, vel = this.vel!;
    const edges = this.net.edges;
    const E = edges.length / 2;
    const k = 0.18;
    const steps = Math.min(3, Math.ceil(dt * 120));
    const h = Math.min(dt, 0.05) / steps;
    for (let s = 0; s < steps; s++) {
      // Repulsion (sampled all-pairs for small n).
      const sample = Math.min(n, 48);
      for (let i = 0; i < n; i++) {
        let fx = -pos[i * 3] * 0.6, fy = -pos[i * 3 + 1] * 0.6, fz = -pos[i * 3 + 2] * 0.6;
        for (let q = 0; q < sample; q++) {
          const j = (i + 1 + ((q * 7919 + Math.floor(t * 13)) % (n - 1))) % n;
          const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz + 1e-3;
          const f = (0.0016 * n) / sample / d2;
          fx += dx * f; fy += dy * f; fz += dz * f;
        }
        vel[i * 3] += fx * h; vel[i * 3 + 1] += fy * h; vel[i * 3 + 2] += fz * h;
      }
      for (let e = 0; e < E; e++) {
        const a = edges[e * 2], b2 = edges[e * 2 + 1];
        const dx = pos[b2 * 3] - pos[a * 3], dy = pos[b2 * 3 + 1] - pos[a * 3 + 1], dz = pos[b2 * 3 + 2] - pos[a * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5;
        const f = ((d - k) * 2.2) / d;
        vel[a * 3] += dx * f * h; vel[a * 3 + 1] += dy * f * h; vel[a * 3 + 2] += dz * f * h;
        vel[b2 * 3] -= dx * f * h; vel[b2 * 3 + 1] -= dy * f * h; vel[b2 * 3 + 2] -= dz * f * h;
      }
      for (let i = 0; i < n * 3; i++) {
        vel[i] *= 0.9;
        pos[i] += vel[i] * h;
      }
    }
    // Rewire.
    this.rewireAcc += dt * num(p, 'rewire', 0.6) * 6;
    const rule = str(p, 'rule', 'mixed');
    while (this.rewireAcc >= 1) {
      this.rewireAcc -= 1;
      const e = this.rng.int(0, E);
      const a = edges[e * 2];
      let target = -1;
      const useTriadic = rule === 'triadic' || (rule === 'mixed' && this.rng.next() < 0.5);
      if (rule === 'random') target = this.rng.int(0, n);
      else if (useTriadic) {
        const nb = this.sim.neighbors(a);
        if (nb.length) {
          const mid = nb[this.rng.int(0, nb.length)].node;
          const nb2 = this.sim.neighbors(mid);
          if (nb2.length) target = nb2[this.rng.int(0, nb2.length)].node;
        }
      }
      if (target < 0) target = edges[this.rng.int(0, E) * 2 + this.rng.int(0, 2)]; // ∝ degree
      if (target !== a) {
        this.mesh.rewire(e, a, target);
        this.sim.fire(a, t, sp);
      }
    }
    if (this.rng.next() < dt * 2) this.sim = new NetworkSim(this.net, this.mesh, this.seed);
    this.mesh.updatePositions(pos);
  }

  /** Rebuild the live topology graph when the connection set changes (≤ every 4 s). */
  private topology(dt: number, t: number, input: FrameInput, sp: SimParams): void {
    this.topoCheck -= dt;
    const conns = input.topic<ConnData>('net.connections');
    const net = input.topic<NetData>('net');
    if (this.topoCheck <= 0) {
      this.topoCheck = 4;
      const key = conns ? conns.list.map((c) => `${c.peer}:${c.peerPort}`).sort().join(',') : '';
      if (key !== this.topoKey) {
        this.topoKey = key;
        const built = topologyNetwork(conns ?? null);
        this.topoLabels = built.labels;
        this.swap(built);
        this.growth = 1;
      }
    }
    const rate = ((net?.rxPerSec ?? 0) + (net?.txPerSec ?? 0)) / 1024; // KiB/s
    this.liveRate = rate;
    const firesPerSec = Math.min(40, 0.5 + Math.log2(1 + rate) * 3);
    if (this.rng.next() < firesPerSec * dt) this.sim.fire(0, t, { ...sp, propagation: 0.9, refractory: 0.05 });
    this.sim.step(t, dt, { ...sp, rate: 0, burst: 0, propagation: 0.9, refractory: 0.05 });
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    const names: Record<Mode, string> = { genesis: 'NEURAL GENESIS', galaxy: 'NEURAL GALAXY', evolution: 'NETWORK EVOLUTION', constellation: 'DATA CONSTELLATION', topology: 'NETWORK TOPOLOGY · LIVE', singularity: 'DATA SINGULARITY', lattice: 'WIREFRAME UNIVERSE' };
    const rows: [string, string][] = [['NODES', this.net.n.toLocaleString('en-US')], ['EDGES', this.mesh.edgeCount.toLocaleString('en-US')]];
    if (this.mode === 'genesis') rows.push(['GROWTH', `${(this.growth * 100).toFixed(0)} %`], ['SEED', `0x${this.seed.toString(16)}`]);
    if (this.mode === 'evolution') rows.push(['RULE', str(this.params, 'rule', 'mixed').toUpperCase()]);
    if (this.mode === 'topology') rows.push(['PEERS', String(this.topoLabels.filter((l) => l.sub).length)], ['TRAFFIC', `${this.liveRate.toFixed(1)} KiB/s`]);
    titleBlock(g, info, names[this.mode], rows, [['FIRING', `${this.sim.firesPerSec}/s`]], w);
    if (!this.params.labels) return;
    const pos = this.net.positions;
    const labelNodes = this.mode === 'topology' ? this.topoLabels : [...this.net.hubs].slice(0, this.mode === 'constellation' ? 8 : 4).map((n) => ({ node: n, text: `${this.mode === 'constellation' ? 'DP' : 'N'}-${String(n).padStart(4, '0')}`, sub: `k=${this.net.degree[n]}` }));
    g.save();
    g.font = `9px "${info.colors.mono}", monospace`;
    for (const l of labelNodes.slice(0, 40)) {
      const wp = new THREE.Vector3(pos[l.node * 3], pos[l.node * 3 + 1], pos[l.node * 3 + 2]).applyMatrix4(this.root.matrixWorld);
      const p = info.project(wp);
      if (!p.visible || p.x < 0 || p.x > w || p.y < 30 || p.y > h) continue;
      g.globalAlpha = 0.8;
      g.fillStyle = info.colors.fg;
      g.fillText(l.text, p.x + 6, p.y - 3);
      if (l.sub) {
        g.globalAlpha = 0.5;
        g.fillStyle = info.colors.dim;
        g.fillText(l.sub, p.x + 6, p.y + 8);
      }
    }
    if (this.mode === 'topology' && this.net.n <= 1) {
      g.globalAlpha = 0.7;
      g.fillStyle = info.colors.dim;
      g.textAlign = 'center';
      g.fillText('AWAITING CONNECTION DATA', w / 2, h / 2 + 40);
    }
    g.restore();
  }

  stats() {
    return { mode: this.mode, nodes: this.net.n, edges: this.mesh.edgeCount, firing: this.sim.firesPerSec };
  }

  gpuBytes(): number {
    return this.mesh.bytes;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

/** Build host → subnet → peer graph from live connection data. */
function topologyNetwork(conns: ConnData | null): Network & { labels: { node: number; text: string; sub?: string }[] } {
  const subnets = new Map<string, { peers: Map<string, string | null> }>();
  for (const c of conns?.list ?? []) {
    const sub = c.peer.includes(':') ? c.peer.split(':').slice(0, 3).join(':') + '::/48' : c.peer.split('.').slice(0, 3).join('.') + '.0/24';
    let s = subnets.get(sub);
    if (!s) subnets.set(sub, (s = { peers: new Map() }));
    s.peers.set(c.peer, c.process);
  }
  const positions: number[] = [0, 0, 0];
  const labels: { node: number; text: string; sub?: string }[] = [{ node: 0, text: 'LOCALHOST' }];
  const edges: number[] = [];
  const subs = [...subnets.entries()].slice(0, 48);
  subs.forEach(([name, s], i) => {
    const a = (i / Math.max(1, subs.length)) * Math.PI * 2;
    const y = Math.sin(i * 2.3) * 0.25;
    const si = positions.length / 3;
    positions.push(Math.cos(a) * 0.55, y, Math.sin(a) * 0.55);
    labels.push({ node: si, text: name });
    edges.push(0, si);
    const peers = [...s.peers.entries()].slice(0, 24);
    peers.forEach(([peer, proc], j) => {
      const b2 = a + (j - (peers.length - 1) / 2) * 0.12;
      const pi = positions.length / 3;
      positions.push(Math.cos(b2) * 1.05, y + Math.sin(j * 1.7) * 0.18, Math.sin(b2) * 1.05);
      labels.push({ node: pi, text: peer, sub: proc ?? undefined });
      edges.push(si, pi);
    });
  });
  const n = positions.length / 3;
  const pos = Float32Array.from(positions);
  const E = edges.length / 2;
  const lengths = new Float32Array(E);
  const degree = new Uint16Array(n);
  for (let e = 0; e < E; e++) {
    const a = edges[e * 2], b2 = edges[e * 2 + 1];
    lengths[e] = Math.hypot(pos[a * 3] - pos[b2 * 3], pos[a * 3 + 1] - pos[b2 * 3 + 1], pos[a * 3 + 2] - pos[b2 * 3 + 2]);
    degree[a]++; degree[b2]++;
  }
  const base = n < 2 ? generateNetwork({ nodes: 16, degree: 1, algorithm: 'knn', layout: 'constellation', shell: 0, clustering: 0, seed: 1 }) : null;
  if (base) return { ...base, positions: base.positions.map(() => 0), edges: new Uint32Array(0), lengths: new Float32Array(0), order: new Float32Array(0), labels: [{ node: 0, text: 'LOCALHOST' }] };
  return {
    n, positions: pos, edges: Uint32Array.from(edges), lengths, order: new Float32Array(E), degree, cluster: new Uint16Array(n), hubs: Uint32Array.from([0]), arcs: false, nodeOrder: new Float32Array(n), ms: 0, labels,
  };
}

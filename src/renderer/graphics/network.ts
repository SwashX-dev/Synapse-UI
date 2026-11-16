/**
 * GPU network renderer + spiking-cascade simulation shared by the neural engines.
 *
 * Edges are ONE instanced draw call: a template polyline of S segments is
 * instanced per edge, the curve (quadratic bow or great-circle arc) is built
 * in the vertex shader, and impulses are computed on the GPU from each
 * node's last firing time (a float texture). The CPU only decides *when*
 * nodes fire; it never touches per-vertex data after construction.
 */
import * as THREE from 'three';
import type { Network } from './netgen';
import { Rng } from '../../shared/random';
import { POINT_FRAG } from './glsl';

const FIRE_W = 512;

const FIRE_FN = /* glsl */ `
uniform sampler2D uFire;
float fireAt(float idx) { int i = int(idx + 0.5); return texelFetch(uFire, ivec2(i % ${FIRE_W}, i / ${FIRE_W}), 0).r; }
`;

const EDGE_VERT = /* glsl */ `
${FIRE_FN}
uniform float uTime, uPulseSpeed, uPulseWidth, uTrail, uPulseGain, uLineAlpha, uCurv, uGrowth, uBreath, uHighlight, uOpacity, uArc, uFogNear, uFogFar, uLinePulse, uInk;
uniform vec3 uColLine, uColPulse, uColHi;
attribute float t;
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iInfo;
attribute float iOrder;
varying float vAlpha;
varying vec3 vColor;

vec3 curvePoint(vec3 a, vec3 b, float s, float rnd) {
  if (uArc > 0.5) {
    float ra = length(a), rb = length(b);
    vec3 na = a / max(ra, 1e-4), nb = b / max(rb, 1e-4);
    float om = acos(clamp(dot(na, nb), -0.9995, 0.9995));
    vec3 p = (sin((1.0 - s) * om) * na + sin(s * om) * nb) / sin(om);
    return p * mix(ra, rb, s) * (1.0 + 0.06 * sin(3.14159265 * s) * uCurv * (0.4 + rnd));
  }
  vec3 mid = (a + b) * 0.5;
  float ml = length(mid);
  vec3 n = ml > 1e-3 ? mid / ml : normalize(cross(b - a, vec3(0.0, 1.0, 0.0)) + vec3(1e-3));
  float bow = (rnd - 0.38) * uCurv * length(b - a) * 0.85;
  vec3 c = mid + n * bow;
  return mix(mix(a, c, s), mix(c, b, s), s);
}

float pulseShape(float x, float w, float tw) {
  return x > 0.0 ? exp(-(x * x) / (w * w)) : exp(x / tw);
}

void main() {
  float len = max(iInfo.z, 1e-3);
  vec3 p = curvePoint(iA, iB, t, iInfo.w);
  float g = clamp((uGrowth - iOrder) * 18.0, 0.0, 1.0);
  float reveal = 1.0 - step(g + 1e-4, t);
  float breath = 1.0 - uBreath * smoothstep(0.6, 1.0, sin(uTime * 0.3 + iInfo.w * 61.0) * 0.5 + 0.5);
  float travel = uPulseSpeed / len;
  float w = uPulseWidth / len;
  float tw = w * (0.6 + uTrail * 8.0);
  float da = uTime - fireAt(iInfo.x);
  float db = uTime - fireAt(iInfo.y);
  float ha = da * travel;
  float hb = 1.0 - db * travel;
  float pa = (da >= 0.0) ? pulseShape(t - ha, w, tw) * (1.0 - smoothstep(1.0, 1.0 + 4.0 * tw + w, ha)) : 0.0;
  float pb = (db >= 0.0) ? pulseShape(hb - t, w, tw) * (1.0 - smoothstep(1.0, 1.0 + 4.0 * tw + w, 1.0 - hb)) : 0.0;
  float pulse = max(pa, pb);
  float hi = (abs(iInfo.x - uHighlight) < 0.5 || abs(iInfo.y - uHighlight) < 0.5) ? 1.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float fog = clamp(1.0 - (-mv.z - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.18, 1.0);
  vAlpha = (uLineAlpha * breath + pulse * uPulseGain + hi * 0.55 + uLinePulse * 0.15) * reveal * fog * uOpacity * uInk;
  vColor = mix(uColLine, uColPulse, clamp(pulse * 1.2, 0.0, 1.0)) + hi * uColHi * 0.6;
  gl_Position = projectionMatrix * mv;
}
`;

const EDGE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha < 0.002) discard;
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

const NODE_VERT = /* glsl */ `
${FIRE_FN}
uniform float uTime, uNodeSize, uScale, uGrowth, uHighlight, uOpacity, uFogNear, uFogFar, uNodeAlpha;
uniform vec3 uColNode, uColFire;
attribute float aIndex;
attribute float aDeg;
attribute float aOrder;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float since = uTime - fireAt(aIndex);
  float glow = since >= 0.0 ? exp(-since * 2.6) : 0.0;
  float vis = smoothstep(aOrder - 0.02, aOrder + 0.02, uGrowth);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float hi = abs(aIndex - uHighlight) < 0.5 ? 1.0 : 0.0;
  float size = uNodeSize * (0.55 + 0.3 * log(1.0 + aDeg)) * (1.0 + glow * 1.8 + hi * 2.5);
  gl_PointSize = clamp(size * uScale / max(-mv.z, 1e-3), 0.0, 64.0);
  float fog = clamp(1.0 - (-mv.z - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.2, 1.0);
  vAlpha = (uNodeAlpha + glow * 1.5 + hi * 2.0) * vis * fog * uOpacity;
  vColor = mix(uColNode, uColFire, clamp(glow + hi, 0.0, 1.0));
  gl_Position = projectionMatrix * mv;
}
`;

const NODE_FRAG = /* glsl */ `
${POINT_FRAG}
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = softPoint(gl_PointCoord) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

export interface NetworkMeshOptions { segments: number; colors: { line: THREE.Color; pulse: THREE.Color; node: THREE.Color; highlight: THREE.Color } }

export class NetworkMesh {
  readonly group = new THREE.Group();
  readonly fire: Float32Array;
  readonly fireTex: THREE.DataTexture;
  readonly edgeUniforms: Record<string, THREE.IUniform>;
  readonly nodeUniforms: Record<string, THREE.IUniform>;
  private edgeGeo: THREE.InstancedBufferGeometry;
  private nodeGeo: THREE.BufferGeometry;
  private edgeMesh: THREE.LineSegments;
  private nodeMesh: THREE.Points;
  private dirty = false;
  private iA: THREE.InstancedBufferAttribute;
  private iB: THREE.InstancedBufferAttribute;
  private iInfo: THREE.InstancedBufferAttribute;
  bytes = 0;

  constructor(readonly net: Network, opts: NetworkMeshOptions) {
    const n = net.n;
    const E = net.edges.length / 2;
    const rows = Math.ceil(n / FIRE_W);
    this.fire = new Float32Array(FIRE_W * rows).fill(-1e4);
    this.fireTex = new THREE.DataTexture(this.fire, FIRE_W, rows, THREE.RedFormat, THREE.FloatType);
    this.fireTex.minFilter = this.fireTex.magFilter = THREE.NearestFilter;
    this.fireTex.needsUpdate = true;

    // Template polyline (segments as line pairs) parameterised by t ∈ [0,1].
    const S = Math.max(1, opts.segments);
    const tArr = new Float32Array(S * 2);
    for (let i = 0; i < S; i++) { tArr[i * 2] = i / S; tArr[i * 2 + 1] = (i + 1) / S; }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * 2 * 3), 3));
    g.setAttribute('t', new THREE.BufferAttribute(tArr, 1));
    const a = new Float32Array(E * 3), b2 = new Float32Array(E * 3), info = new Float32Array(E * 4), order = new Float32Array(E);
    const rng = new Rng(n * 7 + E);
    for (let e = 0; e < E; e++) {
      const s = net.edges[e * 2], d = net.edges[e * 2 + 1];
      a.set(net.positions.subarray(s * 3, s * 3 + 3), e * 3);
      b2.set(net.positions.subarray(d * 3, d * 3 + 3), e * 3);
      info[e * 4] = s; info[e * 4 + 1] = d; info[e * 4 + 2] = net.lengths[e]; info[e * 4 + 3] = rng.next();
      order[e] = net.order[e];
    }
    this.iA = new THREE.InstancedBufferAttribute(a, 3);
    this.iB = new THREE.InstancedBufferAttribute(b2, 3);
    g.setAttribute('iA', this.iA);
    g.setAttribute('iB', this.iB);
    this.iInfo = new THREE.InstancedBufferAttribute(info, 4);
    g.setAttribute('iInfo', this.iInfo);
    g.setAttribute('iOrder', new THREE.InstancedBufferAttribute(order, 1));
    g.instanceCount = E;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    this.edgeGeo = g;
    this.bytes += (a.byteLength + b2.byteLength + info.byteLength + order.byteLength + tArr.byteLength) + this.fire.byteLength;

    this.edgeUniforms = {
      uFire: { value: this.fireTex }, uTime: { value: 0 }, uPulseSpeed: { value: 0.6 }, uPulseWidth: { value: 0.03 }, uTrail: { value: 0.4 }, uPulseGain: { value: 1.2 },
      uLineAlpha: { value: 0.05 }, uCurv: { value: 0.5 }, uGrowth: { value: 1 }, uBreath: { value: 0.3 }, uHighlight: { value: -1 }, uOpacity: { value: 1 }, uArc: { value: net.arcs ? 1 : 0 },
      uFogNear: { value: 1 }, uFogFar: { value: 5 }, uLinePulse: { value: 0 }, uInk: { value: 1 },
      uColLine: { value: opts.colors.line.clone() }, uColPulse: { value: opts.colors.pulse.clone() }, uColHi: { value: opts.colors.highlight.clone() },
    };
    const edgeMat = new THREE.ShaderMaterial({ vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, uniforms: this.edgeUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.edgeMesh = new THREE.LineSegments(g, edgeMat);
    this.edgeMesh.frustumCulled = false;

    const ng = new THREE.BufferGeometry();
    const idx = new Float32Array(n), deg = new Float32Array(n), nOrder = new Float32Array(n);
    for (let i = 0; i < n; i++) { idx[i] = i; deg[i] = net.degree[i]; nOrder[i] = net.nodeOrder[i] ?? 0; }
    ng.setAttribute('position', new THREE.BufferAttribute(net.positions.slice(), 3));
    ng.setAttribute('aIndex', new THREE.BufferAttribute(idx, 1));
    ng.setAttribute('aDeg', new THREE.BufferAttribute(deg, 1));
    ng.setAttribute('aOrder', new THREE.BufferAttribute(nOrder, 1));
    this.nodeGeo = ng;
    this.bytes += n * 4 * 6;
    this.nodeUniforms = {
      uFire: { value: this.fireTex }, uTime: this.edgeUniforms.uTime, uNodeSize: { value: 1 }, uScale: { value: 300 }, uGrowth: this.edgeUniforms.uGrowth, uHighlight: this.edgeUniforms.uHighlight,
      uOpacity: this.edgeUniforms.uOpacity, uFogNear: this.edgeUniforms.uFogNear, uFogFar: this.edgeUniforms.uFogFar, uNodeAlpha: { value: 0.35 },
      uColNode: { value: opts.colors.node.clone() }, uColFire: { value: opts.colors.pulse.clone() },
    };
    const nodeMat = new THREE.ShaderMaterial({ vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, uniforms: this.nodeUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.nodeMesh = new THREE.Points(ng, nodeMat);
    this.nodeMesh.frustumCulled = false;
    this.group.add(this.edgeMesh, this.nodeMesh);
  }

  get edgeCount(): number {
    return this.net.edges.length / 2;
  }

  markFire(i: number, t: number): void {
    this.fire[i] = t;
    this.dirty = true;
  }

  setColors(c: NetworkMeshOptions['colors']): void {
    (this.edgeUniforms.uColLine.value as THREE.Color).copy(c.line);
    (this.edgeUniforms.uColPulse.value as THREE.Color).copy(c.pulse);
    (this.edgeUniforms.uColHi.value as THREE.Color).copy(c.highlight);
    (this.nodeUniforms.uColNode.value as THREE.Color).copy(c.node);
    (this.nodeUniforms.uColFire.value as THREE.Color).copy(c.pulse);
  }

  /** Reconnect edge e to (a, b) — used by evolving topologies. */
  rewire(e: number, a: number, b: number): void {
    const net = this.net;
    net.edges[e * 2] = a;
    net.edges[e * 2 + 1] = b;
    const p = net.positions;
    const len = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]) || 1e-3;
    net.lengths[e] = len;
    const info = this.iInfo.array as Float32Array;
    info[e * 4] = a;
    info[e * 4 + 1] = b;
    info[e * 4 + 2] = len;
    this.iInfo.needsUpdate = true;
  }

  /** Replace node positions (dynamic layouts). Endpoints of every edge are refreshed. */
  updatePositions(pos: Float32Array): void {
    const net = this.net;
    const E = this.edgeCount;
    const a = this.iA.array as Float32Array, b2 = this.iB.array as Float32Array;
    for (let e = 0; e < E; e++) {
      const s = net.edges[e * 2] * 3, d = net.edges[e * 2 + 1] * 3;
      a[e * 3] = pos[s]; a[e * 3 + 1] = pos[s + 1]; a[e * 3 + 2] = pos[s + 2];
      b2[e * 3] = pos[d]; b2[e * 3 + 1] = pos[d + 1]; b2[e * 3 + 2] = pos[d + 2];
    }
    this.iA.needsUpdate = true;
    this.iB.needsUpdate = true;
    const np = this.nodeGeo.getAttribute('position') as THREE.BufferAttribute;
    (np.array as Float32Array).set(pos.subarray(0, np.array.length));
    np.needsUpdate = true;
    const info = this.iInfo.array as Float32Array;
    for (let e = 0; e < E; e++) info[e * 4 + 2] = Math.hypot(a[e * 3] - b2[e * 3], a[e * 3 + 1] - b2[e * 3 + 1], a[e * 3 + 2] - b2[e * 3 + 2]) || 1e-3;
    this.iInfo.needsUpdate = true;
  }

  upload(time: number, pixelHeight: number, fovDeg: number, pixelRatio = 1): void {
    this.edgeUniforms.uTime.value = time;
    // 1-px lines rendered at reduced resolution cover more screen once upscaled.
    this.edgeUniforms.uInk.value = Math.max(0.2, Math.min(1, pixelRatio));
    this.nodeUniforms.uScale.value = pixelHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    if (this.dirty) {
      this.fireTex.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose(): void {
    this.edgeGeo.dispose();
    this.nodeGeo.dispose();
    (this.edgeMesh.material as THREE.Material).dispose();
    (this.nodeMesh.material as THREE.Material).dispose();
    this.fireTex.dispose();
  }
}

// ───────────────────────────── simulation ─────────────────────────────

/** Min-heap of pending impulse arrivals. */
class ArrivalHeap {
  time: Float64Array;
  node: Uint32Array;
  size = 0;
  constructor(public cap: number) {
    this.time = new Float64Array(cap);
    this.node = new Uint32Array(cap);
  }
  push(t: number, n: number): boolean {
    if (this.size >= this.cap) return false;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.time[p] <= t) break;
      this.time[i] = this.time[p];
      this.node[i] = this.node[p];
      i = p;
    }
    this.time[i] = t;
    this.node[i] = n;
    return true;
  }
  peek(): number {
    return this.size ? this.time[0] : Infinity;
  }
  pop(): number {
    const n = this.node[0];
    const t = this.time[--this.size];
    const nn = this.node[this.size];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.time[c + 1] < this.time[c]) c++;
      if (this.time[c] >= t) break;
      this.time[i] = this.time[c];
      this.node[i] = this.node[c];
      i = c;
    }
    this.time[i] = t;
    this.node[i] = nn;
    return n;
  }
}

export interface SimParams {
  rate: number;          // spontaneous firings per node per second
  propagation: number;   // probability an arriving impulse excites the target
  speed: number;         // impulse speed (scene units / s)
  refractory: number;    // seconds
  burst: number;         // probability per second of a cluster burst
  wave: number;          // 0..1 synchronised plane-wave mode
}

/**
 * Event-driven integrate-and-fire cascade (artistic, inspired by spiking
 * networks; not a biophysical neuron model). Impulses travel along edges at
 * finite speed; arriving impulses may excite the target, which then fires
 * unless refractory, producing branching cascades.
 */
export class NetworkSim {
  private offs: Uint32Array;
  private adj: Uint32Array;
  private adjLen: Float32Array;
  private heap: ArrivalHeap;
  private rng: Rng;
  private lastFire: Float32Array;
  fires = 0;
  firesPerSec = 0;
  private buckets = new Float64Array(8);
  private bucketKey = new Float64Array(8).fill(-1);
  private waveDir = new THREE.Vector3(1, 0, 0);
  private wavePhase = -1.2;
  /** Homeostatic inhibition (0..1) that keeps total activity bounded. */
  inhibition = 1;
  private meanDeg = 1;
  /** Recent firings for signal tracking: [node, time]. */
  readonly recent: { node: number; time: number }[] = [];

  constructor(private net: Network, private mesh: NetworkMesh | null, seed: number) {
    const n = net.n;
    const E = net.edges.length / 2;
    this.offs = new Uint32Array(n + 1);
    for (let e = 0; e < E; e++) { this.offs[net.edges[e * 2] + 1]++; this.offs[net.edges[e * 2 + 1] + 1]++; }
    for (let i = 0; i < n; i++) this.offs[i + 1] += this.offs[i];
    this.adj = new Uint32Array(E * 2);
    this.adjLen = new Float32Array(E * 2);
    const fill = this.offs.slice(0, n);
    for (let e = 0; e < E; e++) {
      const a = net.edges[e * 2], b2 = net.edges[e * 2 + 1];
      this.adj[fill[a]] = b2; this.adjLen[fill[a]++] = net.lengths[e];
      this.adj[fill[b2]] = a; this.adjLen[fill[b2]++] = net.lengths[e];
    }
    this.heap = new ArrivalHeap(Math.min(400_000, E * 8 + 1000));
    this.meanDeg = Math.max(1, (2 * E) / Math.max(1, n));
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.lastFire = new Float32Array(n).fill(-1e4);
  }

  neighbors(i: number): { node: number; len: number }[] {
    const out: { node: number; len: number }[] = [];
    for (let q = this.offs[i]; q < this.offs[i + 1]; q++) out.push({ node: this.adj[q], len: this.adjLen[q] });
    return out;
  }

  fire(i: number, t: number, p: SimParams): void {
    if (t - this.lastFire[i] < p.refractory) return;
    this.lastFire[i] = t;
    this.mesh?.markFire(i, t);
    this.fires++;
    const bk = Math.floor(t * 4);
    const slot = ((bk % 8) + 8) % 8;
    if (this.bucketKey[slot] !== bk) { this.bucketKey[slot] = bk; this.buckets[slot] = 0; }
    this.buckets[slot]++;
    this.recent.push({ node: i, time: t });
    if (this.recent.length > 64) this.recent.shift();
    // `propagation` sets the branching ratio σ = 2·propagation (0.5 → critical),
    // normalised by mean degree so dense and sparse graphs behave alike.
    const pEdge = Math.min(0.95, ((2 * p.propagation) / Math.max(1, this.meanDeg - 1)) * this.inhibition);
    for (let q = this.offs[i]; q < this.offs[i + 1]; q++) {
      if (this.rng.next() < pEdge) this.heap.push(t + this.adjLen[q] / Math.max(0.01, p.speed), this.adj[q]);
    }
  }

  lastFireTime(i: number): number {
    return this.lastFire[i];
  }

  step(t: number, dt: number, p: SimParams): void {
    const n = this.net.n;
    if (dt > 0) {
      // Spontaneous activity (Poisson).
      const expected = n * p.rate * dt;
      let k = Math.floor(expected);
      if (this.rng.next() < expected - k) k++;
      for (let j = 0; j < Math.min(k, 2000); j++) this.fire(this.rng.int(0, n), t - this.rng.next() * dt, p);
      // Cluster bursts.
      if (this.rng.next() < p.burst * dt) {
        const c = this.rng.int(0, n);
        const nb = this.neighbors(c);
        this.fire(c, t, p);
        for (const x of nb) this.fire(x.node, t + x.len / p.speed, p);
      }
      // Synchronised travelling wave.
      if (p.wave > 0) {
        const prev = this.wavePhase;
        this.wavePhase += dt * 0.55;
        if (this.wavePhase > 1.3) {
          this.wavePhase = -1.3;
          this.waveDir.set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).normalize();
        }
        const pos = this.net.positions;
        const prob = p.wave;
        const d = this.waveDir;
        for (let i = 0; i < n; i++) {
          const x = pos[i * 3] * d.x + pos[i * 3 + 1] * d.y + pos[i * 3 + 2] * d.z;
          if (x > prev && x <= this.wavePhase && this.rng.next() < prob) this.fire(i, t, p);
        }
      }
    }
    // Deliver arrivals.
    let budget = 60_000;
    while (this.heap.size && this.heap.peek() <= t && budget-- > 0) {
      const at = this.heap.peek();
      const node = this.heap.pop();
      this.fire(node, at, p);
    }
    const now = Math.floor(t * 4);
    let sum = 0;
    for (let i = 0; i < 8; i++) if (this.bucketKey[i] > now - 4 && this.bucketKey[i] <= now) sum += this.buckets[i];
    this.firesPerSec = sum;
    // Homeostasis: keep the network-wide firing rate below ~7 % of nodes per second.
    const ceiling = n * 0.07 + 20;
    if (sum > ceiling) this.inhibition = Math.max(0.05, this.inhibition * 0.92);
    else this.inhibition = Math.min(1, this.inhibition * 1.01 + 0.0005);
  }

  get pending(): number {
    return this.heap.size;
  }
}

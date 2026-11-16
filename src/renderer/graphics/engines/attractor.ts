/**
 * Mathematical Chaos — strange attractors integrated with classical RK4.
 * Many trajectories start within 1e-3 of each other and visibly diverge
 * (sensitive dependence on initial conditions). Trails are GPU ring buffers:
 * each frame only the newly integrated points are uploaded.
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num, str } from '../types';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';
import { POINT_FRAG } from '../glsl';

type Vec = [number, number, number];
interface System { name: string; eq: string[]; f: (p: Vec, prm: Record<string, number>) => Vec; params: Record<string, number>; start: Vec; scale: number; center: Vec; dt: number }

export const SYSTEMS: Record<string, System> = {
  lorenz: {
    name: 'LORENZ', eq: ['ẋ = σ(y − x)', 'ẏ = x(ρ − z) − y', 'ż = xy − βz'], params: { sigma: 10, rho: 28, beta: 8 / 3 },
    f: ([x, y, z], k) => [k.sigma * (y - x), x * (k.rho - z) - y, x * y - k.beta * z], start: [0.1, 0, 20], scale: 1 / 26, center: [0, 0, 24], dt: 0.006,
  },
  aizawa: {
    name: 'AIZAWA', eq: ['ẋ = (z − b)x − dy', 'ẏ = dx + (z − b)y', 'ż = c + az − z³/3 − (x²+y²)(1+ez) + fzx³'], params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 },
    f: ([x, y, z], k) => [(z - k.b) * x - k.d * y, k.d * x + (z - k.b) * y, k.c + k.a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + k.e * z) + k.f * z * x * x * x], start: [0.1, 0, 0], scale: 0.7, center: [0, 0, 0.7], dt: 0.01,
  },
  thomas: {
    name: 'THOMAS', eq: ['ẋ = sin y − bx', 'ẏ = sin z − by', 'ż = sin x − bz'], params: { b: 0.208186 },
    f: ([x, y, z], k) => [Math.sin(y) - k.b * x, Math.sin(z) - k.b * y, Math.sin(x) - k.b * z], start: [1.1, 1.1, -0.01], scale: 1 / 4.2, center: [0, 0, 0], dt: 0.05,
  },
  halvorsen: {
    name: 'HALVORSEN', eq: ['ẋ = −ax − 4y − 4z − y²', 'ẏ = −ay − 4z − 4x − z²', 'ż = −az − 4x − 4y − x²'], params: { a: 1.89 },
    f: ([x, y, z], k) => [-k.a * x - 4 * y - 4 * z - y * y, -k.a * y - 4 * z - 4 * x - z * z, -k.a * z - 4 * x - 4 * y - x * x], start: [-1.48, -1.51, 2.04], scale: 1 / 9, center: [-2, -2, -2], dt: 0.006,
  },
  rossler: {
    name: 'RÖSSLER', eq: ['ẋ = −y − z', 'ẏ = x + ay', 'ż = b + z(x − c)'], params: { a: 0.2, b: 0.2, c: 5.7 },
    f: ([x, y, z], k) => [-y - z, x + k.a * y, k.b + z * (x - k.c)], start: [1, 1, 0], scale: 1 / 12, center: [0, 0, 6], dt: 0.02,
  },
  dadras: {
    name: 'DADRAS', eq: ['ẋ = y − ax + byz', 'ẏ = cy − xz + z', 'ż = dxy − ez'], params: { a: 3, b: 2.7, c: 1.7, d: 2, e: 9 },
    f: ([x, y, z], k) => [y - k.a * x + k.b * y * z, k.c * y - x * z + z, k.d * x * y - k.e * z], start: [1.1, 2.1, -2], scale: 1 / 9, center: [0, 0, 0], dt: 0.008,
  },
};

function rk4(sys: System, p: Vec, h: number, k: Record<string, number>): Vec {
  const add = (a: Vec, b2: Vec, s: number): Vec => [a[0] + b2[0] * s, a[1] + b2[1] * s, a[2] + b2[2] * s];
  const k1 = sys.f(p, k);
  const k2 = sys.f(add(p, k1, h / 2), k);
  const k3 = sys.f(add(p, k2, h / 2), k);
  const k4 = sys.f(add(p, k3, h), k);
  return [p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]), p[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])];
}

const LINE_VERT = /* glsl */ `
uniform float uHead, uLen, uOpacity;
attribute float aIdx;
attribute float aSpeed;
varying float vA;
varying float vS;
void main() {
  float age = mod(uHead - aIdx + uLen, uLen) / uLen;
  vA = pow(1.0 - age, 1.4) * step(0.0005, age) * uOpacity;
  vS = aSpeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const LINE_FRAG = /* glsl */ `
uniform vec3 uColA, uColB;
uniform float uAlpha;
varying float vA;
varying float vS;
void main() { if (vA < 0.003) discard; gl_FragColor = vec4(mix(uColA, uColB, clamp(vS, 0.0, 1.0)), vA * uAlpha); }`;
const HEAD_FRAG = /* glsl */ `
${POINT_FRAG}
uniform vec3 uCol;
void main() { float a = softPoint(gl_PointCoord); if (a < 0.01) discard; gl_FragColor = vec4(uCol, a); }`;

export const attractor: EngineDef = {
  id: 'attractor',
  name: 'Mathematical Chaos',
  description: 'Strange attractors (Lorenz, Aizawa, Thomas, Halvorsen, Rössler, Dadras) integrated with RK4.',
  artistic: false,
  science: 'Exact ODEs integrated with fourth-order Runge–Kutta at a fixed step; trajectories are numerically accurate to the step size (chaotic systems amplify any error, so individual paths are not long-term predictions). Coordinates are scaled to fit the view.',
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'system', label: 'System', type: 'select', default: 'lorenz', group: 'System', rebuild: true, options: Object.entries(SYSTEMS).map(([value, s]) => ({ value, label: s.name[0] + s.name.slice(1).toLowerCase() })) },
    { key: 'trajectories', label: 'Trajectories (0 = by quality)', type: 'int', default: 0, min: 0, max: 2048, step: 16, group: 'System', rebuild: true },
    { key: 'trail', label: 'Trail length', type: 'int', default: 600, min: 50, max: 4000, step: 50, group: 'System', rebuild: true },
    { key: 'start', label: 'Initial conditions', type: 'select', default: 'distributed', group: 'System', rebuild: true, options: [{ value: 'distributed', label: 'Distributed along the attractor' }, { value: 'clustered', label: 'Clustered (watch divergence)' }] },
    { key: 'spread', label: 'Initial spread', type: 'number', default: 0.001, min: 0.00001, max: 1, step: 0.0001, group: 'System', rebuild: true },
    { key: 'stepsPerFrame', label: 'Integration rate', type: 'number', default: 2, min: 0.1, max: 12, step: 0.1, group: 'System' },
    { key: 'p1', label: 'Parameter 1 (σ / a / b)', type: 'number', default: 0, min: -50, max: 50, step: 0.001, group: 'Coefficients', description: '0 keeps the canonical value.' },
    { key: 'p2', label: 'Parameter 2 (ρ / b / c)', type: 'number', default: 0, min: -50, max: 50, step: 0.001, group: 'Coefficients' },
    { key: 'p3', label: 'Parameter 3 (β / c / d)', type: 'number', default: 0, min: -50, max: 50, step: 0.001, group: 'Coefficients' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
    { key: 'rotation', label: 'Rotation', type: 'number', default: 0.3, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.5, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new AttractorEngine(ctx.quality, ctx.seed, ctx.params, ctx.colors);
  },
};

class AttractorEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.1;
  private sys: System;
  private k: Record<string, number>;
  private state: Vec[];
  private L: number;
  private n: number;
  private head = 0;
  private posAttr: THREE.BufferAttribute;
  private speedAttr: THREE.BufferAttribute;
  private headAttr: THREE.BufferAttribute;
  private lineU: Record<string, THREE.IUniform>;
  private headU: Record<string, THREE.IUniform>;
  private group = new THREE.Group();
  private disp: { dispose(): void }[] = [];
  private acc = 0;
  params: Params;

  constructor(quality: number, seed: number, params: Params, colors: VizColors) {
    this.params = params;
    this.sys = SYSTEMS[str(params, 'system', 'lorenz')] ?? SYSTEMS.lorenz;
    this.k = { ...this.sys.params };
    this.applyCoefficients(params);
    this.n = num(params, 'trajectories', 0) || [48, 128, 320, 640][quality] || 128;
    this.L = num(params, 'trail', 600);
    const rng = new Rng(seed);
    const spread = num(params, 'spread', 0.001);
    // Warm up onto the attractor, then either distribute trajectories along the
    // orbit (shows the whole attractor at once) or cluster them within `spread`
    // of one point (shows sensitive dependence as they diverge).
    let p: Vec = [...this.sys.start];
    for (let i = 0; i < 3000; i++) p = rk4(this.sys, p, this.sys.dt, this.k);
    const clustered = str(params, 'start', 'distributed') === 'clustered';
    const orbit: Vec[] = [];
    for (let i = 0; i < this.n * 40; i++) { p = rk4(this.sys, p, this.sys.dt, this.k); if (i % 40 === 0) orbit.push(p); }
    this.state = Array.from({ length: this.n }, (_, j) => {
      const base = clustered ? orbit[0] : orbit[j];
      return [base[0] + rng.gauss() * spread, base[1] + rng.gauss() * spread, base[2] + rng.gauss() * spread] as Vec;
    });
    const total = this.n * this.L;
    const pos = new Float32Array(total * 3);
    const idx = new Float32Array(total);
    const spd = new Float32Array(total);
    const index: number[] = [];
    for (let j = 0; j < this.n; j++) {
      const tp = this.map(this.state[j]);
      for (let i = 0; i < this.L; i++) {
        const v = j * this.L + i;
        pos.set(tp, v * 3);
        idx[v] = i;
        if (i < this.L - 1) index.push(v, v + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.speedAttr = new THREE.BufferAttribute(spd, 1);
    this.speedAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
    g.setAttribute('aSpeed', this.speedAttr);
    g.setIndex(index);
    this.lineU = { uHead: { value: 0 }, uLen: { value: this.L }, uOpacity: { value: 1 }, uAlpha: { value: 0.5 }, uColA: { value: colors.neural.clone() }, uColB: { value: colors.pulse.clone() } };
    const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({ vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: this.lineU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    lines.frustumCulled = false;
    const hg = new THREE.BufferGeometry();
    this.headAttr = new THREE.BufferAttribute(new Float32Array(this.n * 3), 3);
    this.headAttr.setUsage(THREE.DynamicDrawUsage);
    hg.setAttribute('position', this.headAttr);
    this.headU = { uCol: { value: colors.pulse.clone() } };
    const heads = new THREE.Points(hg, new THREE.ShaderMaterial({ vertexShader: 'void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(12.0/max(-mv.z,0.01), 1.0, 6.0); gl_Position = projectionMatrix*mv; }', fragmentShader: HEAD_FRAG, uniforms: this.headU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    heads.frustumCulled = false;
    this.group.add(lines, heads);
    this.group.rotation.x = -Math.PI / 2;
    this.scene.add(this.group);
    this.disp.push(g, lines.material as THREE.Material, hg, heads.material as THREE.Material);
  }

  private applyCoefficients(p: Params): void {
    const keys = Object.keys(this.sys.params);
    ['p1', 'p2', 'p3'].forEach((pk, i) => {
      const v = num(p, pk, 0);
      if (keys[i]) this.k[keys[i]] = v !== 0 ? v : this.sys.params[keys[i]];
    });
  }

  private map(p: Vec): Vec {
    const s = this.sys.scale, c = this.sys.center;
    return [(p[0] - c[0]) * s, (p[1] - c[1]) * s, (p[2] - c[2]) * s];
  }

  setParam(key: string, _v: unknown, p: Params): boolean {
    this.params = p;
    if (key.startsWith('p')) this.applyCoefficients(p);
    return true;
  }

  setColors(c: VizColors): void {
    (this.lineU.uColA.value as THREE.Color).copy(c.neural);
    (this.lineU.uColB.value as THREE.Color).copy(c.pulse);
    (this.headU.uCol.value as THREE.Color).copy(c.pulse);
  }

  update(dt: number, _t: number, p: Params, _input: FrameInput): void {
    this.params = p;
    this.acc += dt * 60 * num(p, 'stepsPerFrame', 2);
    const steps = Math.min(64, Math.floor(this.acc));
    this.acc -= steps;
    const pos = this.posAttr.array as Float32Array;
    const spd = this.speedAttr.array as Float32Array;
    const heads = this.headAttr.array as Float32Array;
    for (let s = 0; s < steps; s++) {
      this.head = (this.head + 1) % this.L;
      for (let j = 0; j < this.n; j++) {
        const prev = this.state[j];
        const next = rk4(this.sys, prev, this.sys.dt, this.k);
        if (!Number.isFinite(next[0]) || Math.abs(next[0]) > 1e4) next.splice(0, 3, ...this.sys.start);
        this.state[j] = next;
        const m = this.map(next);
        const v = j * this.L + this.head;
        pos[v * 3] = m[0]; pos[v * 3 + 1] = m[1]; pos[v * 3 + 2] = m[2];
        spd[v] = Math.min(1, Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]) / (this.sys.dt * 60) * this.sys.scale * 2);
        if (s === steps - 1) { heads[j * 3] = m[0]; heads[j * 3 + 1] = m[1]; heads[j * 3 + 2] = m[2]; }
      }
    }
    if (steps) {
      this.posAttr.needsUpdate = true;
      this.speedAttr.needsUpdate = true;
      this.headAttr.needsUpdate = true;
    }
    this.lineU.uHead.value = this.head;
    this.lineU.uOpacity.value = num(p, 'layerOpacity', 1);
    this.lineU.uAlpha.value = 0.055 * num(p, 'brightness', 1) * Math.sqrt(128 / this.n);
    this.group.rotation.z += dt * 0.08 * num(p, 'rotation', 0.3);
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    const coeff = Object.entries(this.k).map(([k, v]) => `${k}=${+v.toFixed(4)}`).join(' ');
    titleBlock(g, info, `MATHEMATICAL CHAOS · ${this.sys.name}`, [['METHOD', 'RK4'], ['Δt', String(this.sys.dt)], ['TRAJ', String(this.n)], ['TRAIL', String(this.L)]], [], w);
    g.save();
    g.font = `10px "${info.colors.mono}", monospace`;
    g.fillStyle = info.colors.dim;
    g.globalAlpha = 0.75;
    this.sys.eq.forEach((e, i) => g.fillText(e, 12, h - 48 + i * 13));
    g.fillText(coeff, 12, h - 48 + this.sys.eq.length * 13);
    g.restore();
  }

  stats() {
    return { system: this.sys.name, trajectories: this.n, trail: this.L };
  }

  gpuBytes(): number {
    return this.n * this.L * 24;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

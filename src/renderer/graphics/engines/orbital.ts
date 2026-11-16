/**
 * Orbital Mechanics — Newtonian N-body gravity integrated with velocity
 * Verlet (symplectic, good long-term energy behaviour) with Plummer
 * softening. Scenarios: planetary system, binary star, the Chenciner–
 * Montgomery figure-eight three-body choreography, and a star cluster.
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num, str } from '../types';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';
import { POINT_FRAG } from '../glsl';

interface Body { m: number; p: THREE.Vector3; v: THREE.Vector3; a: THREE.Vector3 }

export const orbital: EngineDef = {
  id: 'orbital',
  name: 'Orbital Mechanics',
  description: 'N-body gravity with velocity-Verlet integration and orbital trails.',
  artistic: false,
  science: 'Newtonian gravity a = −G Σ mⱼ (rᵢ − rⱼ)/(|rᵢ − rⱼ|² + ε²)^{3/2} integrated with velocity Verlet at a fixed step (G = 1, dimensionless units). The figure-eight uses the published Chenciner–Montgomery initial conditions. Softening ε slightly alters close encounters.',
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'macro',
  params: [
    { key: 'scenario', label: 'Scenario', type: 'select', default: 'planetary', group: 'System', rebuild: true, options: [{ value: 'planetary', label: 'Planetary system' }, { value: 'binary', label: 'Binary star + planets' }, { value: 'figure8', label: 'Figure-eight 3-body' }, { value: 'cluster', label: 'Star cluster' }] },
    { key: 'bodies', label: 'Bodies', type: 'int', default: 9, min: 2, max: 400, group: 'System', rebuild: true },
    { key: 'timeScale', label: 'Time scale', type: 'number', default: 1, min: 0, max: 10, step: 0.01, group: 'System' },
    { key: 'softening', label: 'Softening ε', type: 'number', default: 0.01, min: 0.0001, max: 0.2, step: 0.0001, group: 'System' },
    { key: 'trail', label: 'Trail length', type: 'int', default: 400, min: 10, max: 2000, group: 'Look', rebuild: true },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new NBody(ctx.seed, ctx.params, ctx.colors);
  },
};

class NBody implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 0.85;
  private bodies: Body[] = [];
  private scenario: string;
  private L: number;
  private trailAttr: THREE.BufferAttribute;
  private headAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private trailU: Record<string, THREE.IUniform>;
  private bodyU: Record<string, THREE.IUniform>;
  private head = 0;
  private acc = 0;
  private simT = 0;
  private e0 = 0;
  private scale = 1;
  private disp: { dispose(): void }[] = [];

  constructor(seed: number, params: Params, colors: VizColors) {
    const rng = new Rng(seed);
    this.scenario = str(params, 'scenario', 'planetary');
    const n = num(params, 'bodies', 9);
    const add = (m: number, p: [number, number, number], v: [number, number, number]) => this.bodies.push({ m, p: new THREE.Vector3(...p), v: new THREE.Vector3(...v), a: new THREE.Vector3() });
    if (this.scenario === 'figure8') {
      add(1, [0.97000436, 0, -0.24308753], [0.466203685, 0, 0.43236573]);
      add(1, [-0.97000436, 0, 0.24308753], [0.466203685, 0, 0.43236573]);
      add(1, [0, 0, 0], [-0.93240737, 0, -0.86473146]);
      this.scale = 0.9;
    } else if (this.scenario === 'binary') {
      add(1, [0.12, 0, 0], [0, 0, 1.4]);
      add(1, [-0.12, 0, 0], [0, 0, -1.4]);
      for (let i = 0; i < n - 2; i++) {
        const r = 0.55 + i * 0.12 + rng.next() * 0.05;
        const a = rng.next() * Math.PI * 2;
        const v = Math.sqrt(2 / r);
        add(1e-5, [Math.cos(a) * r, rng.gauss() * 0.01, Math.sin(a) * r], [-Math.sin(a) * v, 0, Math.cos(a) * v]);
      }
    } else if (this.scenario === 'cluster') {
      const v: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < Math.max(n, 30); i++) {
        rng.onSphere(v);
        const r = 0.2 + Math.pow(rng.next(), 0.7) * 0.8;
        const sp = 0.6 * Math.sqrt(1 / (r + 0.2));
        const tang = new THREE.Vector3(...v).cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(sp);
        add(1 / Math.max(n, 30), [v[0] * r, v[1] * r * 0.6, v[2] * r], [tang.x + rng.gauss() * 0.05, rng.gauss() * 0.05, tang.z + rng.gauss() * 0.05]);
      }
    } else {
      add(1, [0, 0, 0], [0, 0, 0]);
      for (let i = 1; i < n; i++) {
        const r = 0.18 * Math.pow(1.38, i) + rng.next() * 0.03;
        const a = rng.next() * Math.PI * 2;
        const e = rng.next() * 0.08;
        const v = Math.sqrt(1 / r) * (1 + e);
        const inc = rng.gauss() * 0.03;
        add(1e-6 * (1 + rng.next() * 300), [Math.cos(a) * r, Math.sin(inc) * r, Math.sin(a) * r], [-Math.sin(a) * v, 0, Math.cos(a) * v]);
      }
      const far = Math.max(...this.bodies.map((b2) => b2.p.length()));
      this.scale = 1.1 / far;
    }
    // Remove net momentum so the system stays centred.
    const P = new THREE.Vector3(), M = this.bodies.reduce((s, b2) => s + b2.m, 0);
    for (const b2 of this.bodies) P.addScaledVector(b2.v, b2.m);
    for (const b2 of this.bodies) b2.v.addScaledVector(P, -1 / M);
    this.computeAcc(num(params, 'softening', 0.01));
    this.e0 = this.energy(num(params, 'softening', 0.01));

    this.L = num(params, 'trail', 400);
    const B = this.bodies.length;
    const tp = new Float32Array(B * this.L * 3), ti = new Float32Array(B * this.L), index: number[] = [];
    for (let j = 0; j < B; j++) for (let i = 0; i < this.L; i++) {
      const v2 = j * this.L + i;
      tp.set([this.bodies[j].p.x * this.scale, this.bodies[j].p.y * this.scale, this.bodies[j].p.z * this.scale], v2 * 3);
      ti[v2] = i;
      if (i < this.L - 1) index.push(v2, v2 + 1);
    }
    const tg = new THREE.BufferGeometry();
    this.trailAttr = new THREE.BufferAttribute(tp, 3);
    this.trailAttr.setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.trailAttr);
    tg.setAttribute('aIdx', new THREE.BufferAttribute(ti, 1));
    tg.setIndex(index);
    this.trailU = { uHead: { value: 0 }, uLen: { value: this.L }, uCol: { value: colors.neural.clone() }, uAlpha: { value: 0.6 } };
    const trails = new THREE.LineSegments(tg, new THREE.ShaderMaterial({
      vertexShader: 'uniform float uHead, uLen; attribute float aIdx; varying float vA; void main(){ float age = mod(uHead - aIdx + uLen, uLen)/uLen; vA = pow(1.0-age, 1.5) * step(0.0005, age); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uCol; uniform float uAlpha; varying float vA; void main(){ if (vA < 0.003) discard; gl_FragColor = vec4(uCol, vA*uAlpha); }',
      uniforms: this.trailU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    trails.frustumCulled = false;
    const hg = new THREE.BufferGeometry();
    this.headAttr = new THREE.BufferAttribute(new Float32Array(B * 3), 3);
    this.headAttr.setUsage(THREE.DynamicDrawUsage);
    const maxM = Math.max(...this.bodies.map((b2) => b2.m));
    this.sizeAttr = new THREE.BufferAttribute(Float32Array.from(this.bodies.map((b2) => 0.02 + 0.06 * Math.cbrt(b2.m / maxM))), 1);
    hg.setAttribute('position', this.headAttr);
    hg.setAttribute('aSize', this.sizeAttr);
    this.bodyU = { uCol: { value: colors.pulse.clone() }, uScale: { value: 400 } };
    const pts = new THREE.Points(hg, new THREE.ShaderMaterial({
      vertexShader: 'attribute float aSize; uniform float uScale; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(aSize*uScale/max(-mv.z,0.01), 2.0, 40.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: `${POINT_FRAG}\nuniform vec3 uCol; void main(){ float a = softPoint(gl_PointCoord); if (a<0.01) discard; gl_FragColor = vec4(uCol, a); }`,
      uniforms: this.bodyU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.frustumCulled = false;
    const sys = new THREE.Group();
    sys.add(trails, pts);
    sys.rotation.x = 0.55;
    this.scene.add(sys);
    this.disp.push(tg, trails.material as THREE.Material, hg, pts.material as THREE.Material);
  }

  private computeAcc(eps: number): void {
    const B = this.bodies;
    for (const b2 of B) b2.a.set(0, 0, 0);
    const e2 = eps * eps;
    const d = new THREE.Vector3();
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      d.subVectors(B[j].p, B[i].p);
      const r2 = d.lengthSq() + e2;
      const inv = 1 / (r2 * Math.sqrt(r2));
      B[i].a.addScaledVector(d, B[j].m * inv);
      B[j].a.addScaledVector(d, -B[i].m * inv);
    }
  }

  private energy(eps: number): number {
    let e = 0;
    const B = this.bodies;
    for (const b2 of B) e += 0.5 * b2.m * b2.v.lengthSq();
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) e -= (B[i].m * B[j].m) / Math.sqrt(B[i].p.distanceToSquared(B[j].p) + eps * eps);
    return e;
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.trailU.uCol.value as THREE.Color).copy(c.neural);
    (this.bodyU.uCol.value as THREE.Color).copy(c.pulse);
  }

  update(dt: number, _t: number, p: Params, input: FrameInput): void {
    const eps = num(p, 'softening', 0.01);
    const h = this.scenario === 'figure8' ? 0.002 : this.scenario === 'cluster' ? 0.002 : 0.0015;
    this.acc += dt * num(p, 'timeScale', 1) * (this.scenario === 'planetary' ? 0.6 : 0.4);
    let steps = 0;
    while (this.acc >= h && steps < 400) {
      for (const b2 of this.bodies) { b2.v.addScaledVector(b2.a, h / 2); b2.p.addScaledVector(b2.v, h); }
      this.computeAcc(eps);
      for (const b2 of this.bodies) b2.v.addScaledVector(b2.a, h / 2);
      this.acc -= h;
      this.simT += h;
      steps++;
      if (steps % 4 === 0) this.pushTrail();
    }
    if (steps) this.pushTrail();
    const hp = this.headAttr.array as Float32Array;
    this.bodies.forEach((b2, i) => { hp[i * 3] = b2.p.x * this.scale; hp[i * 3 + 1] = b2.p.y * this.scale; hp[i * 3 + 2] = b2.p.z * this.scale; });
    this.headAttr.needsUpdate = true;
    this.trailU.uAlpha.value = 0.9 * num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    this.bodyU.uScale.value = input.height;
  }

  private pushTrail(): void {
    this.head = (this.head + 1) % this.L;
    const tp = this.trailAttr.array as Float32Array;
    this.bodies.forEach((b2, j) => {
      const v = j * this.L + this.head;
      tp[v * 3] = b2.p.x * this.scale; tp[v * 3 + 1] = b2.p.y * this.scale; tp[v * 3 + 2] = b2.p.z * this.scale;
    });
    this.trailAttr.needsUpdate = true;
    this.trailU.uHead.value = this.head;
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    const e = this.energy(0.01);
    const drift = this.e0 !== 0 ? Math.abs((e - this.e0) / this.e0) : 0;
    titleBlock(g, info, `ORBITAL MECHANICS · ${this.scenario.toUpperCase()}`, [['BODIES', String(this.bodies.length)], ['INTEGRATOR', 'VELOCITY VERLET'], ['t', this.simT.toFixed(2)], ['|ΔE/E₀|', drift.toExponential(2)]], [], w);
  }

  stats() {
    return { scenario: this.scenario, bodies: this.bodies.length, simTime: this.simT.toFixed(2) };
  }

  gpuBytes(): number {
    return this.bodies.length * this.L * 16;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

/**
 * Electromagnetic Field — electric field lines of point charges.
 * E(r) = Σ qᵢ (r − rᵢ) / |r − rᵢ|³ (Coulomb, Gaussian units, static
 * approximation). Lines are traced with RK4 along Ê from positive charges
 * (and from negative charges backwards when no positive charge exists), then
 * re-traced as the charges move. Test particles flow along the lines.
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num } from '../types';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';
import { POINT_FRAG } from '../glsl';

interface Charge { q: number; base: THREE.Vector3; pos: THREE.Vector3; phase: number; orbit: number }

export const fieldLines: EngineDef = {
  id: 'field-lines',
  name: 'Electromagnetic Field',
  description: 'Field lines of moving point charges, traced with RK4, with particles flowing along them.',
  artistic: false,
  science: 'Electrostatic field of point charges from Coulomb’s law, traced numerically with RK4. Charges move slowly and the field is recomputed quasi-statically (no retardation, magnetic fields or radiation).',
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'charges', label: 'Charges', type: 'int', default: 4, min: 1, max: 10, group: 'System', rebuild: true },
    { key: 'linesPerCharge', label: 'Lines per unit charge', type: 'int', default: 0, min: 0, max: 96, group: 'System', rebuild: true, description: '0 = by quality' },
    { key: 'motion', label: 'Charge motion', type: 'number', default: 0.5, min: 0, max: 3, step: 0.01, group: 'System' },
    { key: 'flow', label: 'Particle flow', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'System' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.45, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new FieldEngine(ctx.quality, ctx.seed, ctx.params, ctx.colors);
  },
};

const MAX_STEPS = 220;

class FieldEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.2;
  private charges: Charge[] = [];
  private lineGeo = new THREE.BufferGeometry();
  private lineMat: THREE.LineBasicMaterial;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private lines: { pts: Float32Array; n: number }[] = [];
  private partGeo = new THREE.BufferGeometry();
  private partAttr: THREE.BufferAttribute;
  private partU: Record<string, THREE.IUniform>;
  private partS: Float32Array;
  private chargeMeshes: THREE.Mesh[] = [];
  private retraceT = 0;
  private colors: VizColors;
  private linesPer: number;
  private maxLines: number;
  private disp: { dispose(): void }[] = [];

  constructor(quality: number, seed: number, params: Params, colors: VizColors) {
    this.colors = colors;
    const rng = new Rng(seed);
    const nc = num(params, 'charges', 4);
    let sum = 0;
    for (let i = 0; i < nc; i++) {
      const q = i === nc - 1 && nc > 1 ? -Math.sign(sum || 1) * (1 + rng.int(0, 2)) : (rng.next() < 0.5 ? -1 : 1) * (1 + rng.int(0, 2));
      sum += q;
      const base = new THREE.Vector3(rng.range(-0.7, 0.7), rng.range(-0.45, 0.45), rng.range(-0.7, 0.7));
      this.charges.push({ q, base, pos: base.clone(), phase: rng.next() * 6.28, orbit: 0.1 + rng.next() * 0.2 });
    }
    this.linesPer = num(params, 'linesPerCharge', 0) || [8, 14, 22, 32][quality] || 14;
    const qPos = this.charges.reduce((a, c) => a + Math.abs(c.q), 0);
    this.maxLines = Math.ceil(this.linesPer * qPos) + 8;
    this.posAttr = new THREE.BufferAttribute(new Float32Array(this.maxLines * MAX_STEPS * 2 * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(this.maxLines * MAX_STEPS * 2 * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.lineGeo.setAttribute('position', this.posAttr);
    this.lineGeo.setAttribute('color', this.colAttr);
    this.lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    const ls = new THREE.LineSegments(this.lineGeo, this.lineMat);
    ls.frustumCulled = false;
    this.scene.add(ls);
    const np = [2000, 5000, 10000, 20000][quality] ?? 5000;
    this.partAttr = new THREE.BufferAttribute(new Float32Array(np * 3), 3);
    this.partAttr.setUsage(THREE.DynamicDrawUsage);
    this.partS = new Float32Array(np * 2);
    for (let i = 0; i < np; i++) { this.partS[i * 2] = rng.next(); this.partS[i * 2 + 1] = 0.3 + rng.next(); }
    this.partGeo.setAttribute('position', this.partAttr);
    this.partU = { uCol: { value: colors.pulse.clone() } };
    const pts = new THREE.Points(this.partGeo, new THREE.ShaderMaterial({
      vertexShader: 'void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(9.0/max(-mv.z,0.01), 1.0, 4.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: `${POINT_FRAG}\nuniform vec3 uCol; void main(){ float a = softPoint(gl_PointCoord); if (a < 0.01) discard; gl_FragColor = vec4(uCol, a*0.45); }`,
      uniforms: this.partU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.frustumCulled = false;
    this.scene.add(pts);
    const sg = new THREE.IcosahedronGeometry(0.035, 2);
    for (const c of this.charges) {
      const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: c.q > 0 ? colors.pulse : colors.accent, wireframe: c.q < 0, transparent: true, opacity: 0.95 }));
      m.scale.setScalar(Math.sqrt(Math.abs(c.q)));
      this.chargeMeshes.push(m);
      this.scene.add(m);
      this.disp.push(m.material as THREE.Material);
    }
    this.disp.push(sg, this.lineGeo, this.lineMat, this.partGeo, pts.material as THREE.Material);
    this.trace();
  }

  private field(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const c of this.charges) {
      const dx = p.x - c.pos.x, dy = p.y - c.pos.y, dz = p.z - c.pos.z;
      const r2 = dx * dx + dy * dy + dz * dz + 1e-6;
      const inv = c.q / (r2 * Math.sqrt(r2));
      out.x += dx * inv; out.y += dy * inv; out.z += dz * inv;
    }
    return out;
  }

  private trace(): void {
    const hasPos = this.charges.some((c) => c.q > 0);
    const sources = this.charges.filter((c) => (hasPos ? c.q > 0 : c.q < 0));
    const dir = hasPos ? 1 : -1;
    this.lines = [];
    const e = new THREE.Vector3(), k1 = new THREE.Vector3(), k2 = new THREE.Vector3(), k3 = new THREE.Vector3(), k4 = new THREE.Vector3(), tmp = new THREE.Vector3();
    const h = 0.012;
    const norm = (v: THREE.Vector3) => v.normalize().multiplyScalar(dir);
    for (const s of sources) {
      const count = Math.round(this.linesPer * Math.abs(s.q));
      for (let i = 0; i < count && this.lines.length < this.maxLines; i++) {
        // Fibonacci directions on a small sphere around the source.
        const y = 1 - ((i + 0.5) / count) * 2;
        const r = Math.sqrt(1 - y * y);
        const th = i * 2.399963;
        const p = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(0.04).add(s.pos);
        const pts = new Float32Array(MAX_STEPS * 3);
        let n = 0;
        for (; n < MAX_STEPS; n++) {
          pts[n * 3] = p.x; pts[n * 3 + 1] = p.y; pts[n * 3 + 2] = p.z;
          norm(this.field(p, k1));
          norm(this.field(tmp.copy(p).addScaledVector(k1, h / 2), k2));
          norm(this.field(tmp.copy(p).addScaledVector(k2, h / 2), k3));
          norm(this.field(tmp.copy(p).addScaledVector(k3, h), k4));
          e.copy(k1).addScaledVector(k2, 2).addScaledVector(k3, 2).add(k4).multiplyScalar(h / 6);
          p.add(e);
          if (p.length() > 2.2) break;
          if (this.charges.some((c) => c !== s && Math.sign(c.q) !== Math.sign(s.q) && c.pos.distanceToSquared(p) < 0.0016)) { n++; break; }
        }
        this.lines.push({ pts, n });
      }
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    let v = 0;
    const cA = this.colors.neural, cB = this.colors.pulse;
    for (const l of this.lines) {
      for (let i = 0; i < l.n - 1; i++) {
        for (const j of [i, i + 1]) {
          pos[v * 3] = l.pts[j * 3]; pos[v * 3 + 1] = l.pts[j * 3 + 1]; pos[v * 3 + 2] = l.pts[j * 3 + 2];
          // Brightness ∝ field strength (log scaled).
          const E = this.field(new THREE.Vector3(l.pts[j * 3], l.pts[j * 3 + 1], l.pts[j * 3 + 2]), e).length();
          const f = Math.min(1, Math.log10(1 + E) / 2.5);
          col[v * 3] = cA.r * (1 - f) + cB.r * f; col[v * 3 + 1] = cA.g * (1 - f) + cB.g * f; col[v * 3 + 2] = cA.b * (1 - f) + cB.b * f;
          v++;
        }
      }
    }
    this.lineGeo.setDrawRange(0, v);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    (this.partU.uCol.value as THREE.Color).copy(c.pulse);
    this.chargeMeshes.forEach((m, i) => (m.material as THREE.MeshBasicMaterial).color.copy(this.charges[i].q > 0 ? c.pulse : c.accent));
    this.trace();
  }

  update(dt: number, t: number, p: Params, _input: FrameInput): void {
    const motion = num(p, 'motion', 0.5);
    this.charges.forEach((c, i) => {
      c.pos.set(c.base.x + Math.cos(t * 0.3 * motion + c.phase) * c.orbit, c.base.y + Math.sin(t * 0.21 * motion + c.phase * 2) * c.orbit * 0.6, c.base.z + Math.sin(t * 0.27 * motion + c.phase) * c.orbit);
      this.chargeMeshes[i].position.copy(c.pos);
    });
    this.retraceT -= dt;
    if (this.retraceT <= 0 && motion > 0) {
      this.retraceT = 0.12;
      this.trace();
    }
    const pa = this.partAttr.array as Float32Array;
    const flow = num(p, 'flow', 1);
    const n = pa.length / 3;
    for (let i = 0; i < n && this.lines.length; i++) {
      const l = this.lines[i % this.lines.length];
      if (l.n < 2) continue;
      this.partS[i * 2] = (this.partS[i * 2] + dt * 0.12 * flow * this.partS[i * 2 + 1]) % 1;
      const f = this.partS[i * 2] * (l.n - 1);
      const k = Math.floor(f), u = f - k;
      const a = k * 3, b2 = Math.min(l.n - 1, k + 1) * 3;
      pa[i * 3] = l.pts[a] + (l.pts[b2] - l.pts[a]) * u;
      pa[i * 3 + 1] = l.pts[a + 1] + (l.pts[b2 + 1] - l.pts[a + 1]) * u;
      pa[i * 3 + 2] = l.pts[a + 2] + (l.pts[b2 + 2] - l.pts[a + 2]) * u;
    }
    this.partAttr.needsUpdate = true;
    this.lineMat.opacity = 0.2 * num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    this.scene.rotation.y += dt * 0.03;
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    titleBlock(g, info, 'ELECTROMAGNETIC FIELD', [['CHARGES', this.charges.map((c) => (c.q > 0 ? `+${c.q}` : String(c.q))).join(' ')], ['LINES', String(this.lines.length)], ['METHOD', 'RK4 / COULOMB']], [], w);
    g.save();
    g.font = `10px "${info.colors.mono}", monospace`;
    g.fillStyle = info.colors.dim;
    g.globalAlpha = 0.7;
    g.fillText('E(r) = Σ qᵢ (r − rᵢ) / |r − rᵢ|³', 12, h - 16);
    g.restore();
    this.charges.forEach((c) => {
      const p = info.project(c.pos);
      if (!p.visible) return;
      g.fillStyle = info.colors.fg;
      g.fillText(c.q > 0 ? `+${c.q}q` : `${c.q}q`, p.x + 8, p.y - 6);
    });
  }

  stats() {
    return { charges: this.charges.length, lines: this.lines.length };
  }

  gpuBytes(): number {
    return this.maxLines * MAX_STEPS * 2 * 24;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

/**
 * Biochemistry engines:
 *   helix     B-DNA double helix with real proportions (Å): radius ≈ 10, rise 3.38/bp,
 *             10.5 bp/turn, strand offset giving major/minor grooves (~22 Å / ~12 Å).
 *   molecule  ball-and-stick models from standard bond lengths/angles or a user XYZ file.
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { bool, num, str } from '../types';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';
import { POINT_FRAG } from '../glsl';

// ───────────────────────────── DNA ─────────────────────────────

const BASES = ['A', 'T', 'G', 'C'] as const;
const PAIR: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

export const helix: EngineDef = {
  id: 'helix',
  name: 'DNA Helix',
  description: 'B-form DNA double helix with grooves, base pairs and a travelling transcription bubble.',
  artistic: false,
  science: 'Geometry uses B-DNA averages: 10.5 base pairs per turn (34.3° twist), 3.38 Å rise, ~10 Å backbone radius, strands offset ~150° to form major/minor grooves. Atoms are not modelled individually; the sequence is random.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'basePairs', label: 'Base pairs', type: 'int', default: 44, min: 10, max: 400, group: 'Structure', rebuild: true },
    { key: 'bpPerTurn', label: 'Base pairs per turn', type: 'number', default: 10.5, min: 6, max: 16, step: 0.1, group: 'Structure', rebuild: true },
    { key: 'grooveOffset', label: 'Strand offset (°)', type: 'number', default: 150, min: 90, max: 180, step: 1, group: 'Structure', rebuild: true },
    { key: 'spin', label: 'Rotation speed', type: 'number', default: 0.4, min: 0, max: 3, step: 0.01, group: 'Animation' },
    { key: 'bubble', label: 'Transcription bubble', type: 'bool', default: true, group: 'Animation' },
    { key: 'bubbleSpeed', label: 'Bubble speed', type: 'number', default: 1, min: 0, max: 5, step: 0.01, group: 'Animation' },
    { key: 'labels', label: 'Sequence labels', type: 'bool', default: true, group: 'Look' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.8, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new HelixEngine(ctx.seed, ctx.params, ctx.colors);
  },
};

class HelixEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.2;
  private group = new THREE.Group();
  private seq: string[];
  private n: number;
  private rungPos: THREE.BufferAttribute;
  private rungBase: Float32Array;
  private rungMat: THREE.LineBasicMaterial;
  private backboneMats: THREE.LineBasicMaterial[] = [];
  private nucU: Record<string, THREE.IUniform>;
  private disp: { dispose(): void }[] = [];
  private bubbleAt = 0;
  colors: VizColors;
  private scale: number;
  private twist: number;
  private offset: number;

  constructor(seed: number, params: Params, colors: VizColors) {
    this.colors = colors;
    const rng = new Rng(seed);
    this.n = num(params, 'basePairs', 84);
    this.seq = Array.from({ length: this.n }, () => BASES[rng.int(0, 4)]);
    const rise = 3.38, R = 10;
    this.twist = (Math.PI * 2) / num(params, 'bpPerTurn', 10.5);
    this.offset = (num(params, 'grooveOffset', 150) * Math.PI) / 180;
    const length = this.n * rise;
    this.scale = 2.3 / length;
    // Backbones (smooth curves, 8 samples per base pair).
    for (let s = 0; s < 2; s++) {
      const pts: number[] = [];
      const samples = this.n * 8;
      for (let i = 0; i < samples; i++) {
        const bp = i / 8;
        const a = bp * this.twist + s * this.offset;
        pts.push(Math.cos(a) * R, bp * rise - length / 2, Math.sin(a) * R);
      }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color: colors.neural, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      this.group.add(new THREE.Line(g, m));
      this.backboneMats.push(m);
      this.disp.push(g, m);
    }
    // Base-pair rungs (two halves so the bubble can open them).
    this.rungBase = new Float32Array(this.n * 4 * 3);
    for (let i = 0; i < this.n; i++) {
      const a0 = i * this.twist, a1 = a0 + this.offset;
      const y = i * rise - length / 2;
      const p0 = [Math.cos(a0) * R, y, Math.sin(a0) * R], p1 = [Math.cos(a1) * R, y, Math.sin(a1) * R];
      const mid = [(p0[0] + p1[0]) / 2, y, (p0[2] + p1[2]) / 2];
      this.rungBase.set([...p0, ...mid, ...mid, ...p1], i * 12);
    }
    const rg = new THREE.BufferGeometry();
    this.rungPos = new THREE.BufferAttribute(this.rungBase.slice(), 3);
    this.rungPos.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('position', this.rungPos);
    this.rungMat = new THREE.LineBasicMaterial({ color: colors.foreground, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
    this.group.add(new THREE.LineSegments(rg, this.rungMat));
    this.disp.push(rg, this.rungMat);
    // Nucleotide glow points at backbone attachment points, sized by base type (purines larger).
    const np = new Float32Array(this.n * 2 * 3), nt = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      np.set(this.rungBase.subarray(i * 12, i * 12 + 3), i * 6);
      np.set(this.rungBase.subarray(i * 12 + 9, i * 12 + 12), i * 6 + 3);
      nt[i * 2] = BASES.indexOf(this.seq[i] as (typeof BASES)[number]);
      nt[i * 2 + 1] = BASES.indexOf(PAIR[this.seq[i]] as (typeof BASES)[number]);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(np, 3));
    ng.setAttribute('aType', new THREE.BufferAttribute(nt, 1));
    this.nucU = { uColA: { value: colors.graph[0]?.clone() ?? colors.pulse.clone() }, uColB: { value: colors.graph[1]?.clone() ?? colors.neural.clone() }, uScale: { value: 1 }, uBright: { value: 1 } };
    const pts = new THREE.Points(ng, new THREE.ShaderMaterial({
      vertexShader: 'attribute float aType; uniform float uScale; varying float vT; void main(){ vT = aType; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp((aType < 2.0 ? 0.05 : 0.04) * uScale / max(-mv.z, 0.01), 1.0, 14.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: `${POINT_FRAG}\nuniform vec3 uColA, uColB; uniform float uBright; varying float vT; void main(){ float a = softPoint(gl_PointCoord); if (a < 0.01) discard; gl_FragColor = vec4(mix(uColA, uColB, step(1.5, vT)), a * uBright); }`,
      uniforms: this.nucU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.group.add(pts);
    this.disp.push(ng, pts.material as THREE.Material);
    this.group.scale.setScalar(this.scale);
    this.group.rotation.z = 0.35;
    this.scene.add(this.group);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    for (const m of this.backboneMats) m.color.copy(c.neural);
    this.rungMat.color.copy(c.foreground);
    (this.nucU.uColA.value as THREE.Color).copy(c.graph[0] ?? c.pulse);
    (this.nucU.uColB.value as THREE.Color).copy(c.graph[1] ?? c.neural);
  }

  update(dt: number, t: number, p: Params, input: FrameInput): void {
    this.group.rotation.y += dt * num(p, 'spin', 0.4);
    const bright = num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    this.rungMat.opacity = 0.45 * bright;
    for (const m of this.backboneMats) m.opacity = 0.9 * bright;
    this.nucU.uBright.value = bright;
    this.nucU.uScale.value = input.height;
    const arr = this.rungPos.array as Float32Array;
    if (bool(p, 'bubble', true)) {
      this.bubbleAt = (t * 3 * num(p, 'bubbleSpeed', 1)) % (this.n + 20) - 10;
      for (let i = 0; i < this.n; i++) {
        const d = Math.abs(i - this.bubbleAt);
        const open = d < 6 ? Math.cos((d / 6) * (Math.PI / 2)) : 0;
        for (let k = 0; k < 4; k++) {
          const bx = this.rungBase[i * 12 + k * 3], by = this.rungBase[i * 12 + k * 3 + 1], bz = this.rungBase[i * 12 + k * 3 + 2];
          // Midpoints retract toward their own strand when the bubble opens the pair.
          if (k === 1 || k === 2) {
            const sx = this.rungBase[i * 12 + (k === 1 ? 0 : 9)], sz = this.rungBase[i * 12 + (k === 1 ? 2 : 11)];
            arr[i * 12 + k * 3] = bx + (sx - bx) * open * 0.75;
            arr[i * 12 + k * 3 + 1] = by;
            arr[i * 12 + k * 3 + 2] = bz + (sz - bz) * open * 0.75;
          } else {
            arr[i * 12 + k * 3] = bx; arr[i * 12 + k * 3 + 1] = by; arr[i * 12 + k * 3 + 2] = bz;
          }
        }
      }
      this.rungPos.needsUpdate = true;
    }
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    const gc = this.seq.filter((b2) => b2 === 'G' || b2 === 'C').length / this.n;
    titleBlock(g, info, 'DNA HELIX · B-FORM', [['BASE PAIRS', String(this.n)], ['TWIST', `${((this.twist * 180) / Math.PI).toFixed(1)}°/bp`], ['RISE', '3.38 Å'], ['GC', `${(gc * 100).toFixed(1)} %`]], [], w);
    g.save();
    g.font = `10px "${info.colors.mono}", monospace`;
    const start = Math.max(0, Math.floor(this.bubbleAt) - 12);
    const window = this.seq.slice(start, start + 32);
    g.fillStyle = info.colors.dim;
    g.fillText(`5′ ${window.join('')} 3′`, 12, h - 28);
    g.fillText(`3′ ${window.map((b2) => PAIR[b2]).join('')} 5′`, 12, h - 15);
    g.restore();
  }

  stats() {
    return { basePairs: this.n };
  }

  gpuBytes(): number {
    return this.n * 400;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

// ───────────────────────────── molecules ─────────────────────────────

interface Atom { el: string; x: number; y: number; z: number }

/** Covalent radii (Å), Cordero et al. 2008. */
const COVALENT: Record<string, number> = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.2, I: 1.39, B: 0.84, Si: 1.11 };
const VDW_SCALE: Record<string, number> = { H: 0.55, C: 0.85, N: 0.82, O: 0.8, F: 0.75, P: 1.0, S: 1.0, Cl: 0.95 };
const CPK: Record<string, string> = { H: '#ffffff', C: '#909090', N: '#3050f8', O: '#ff0d0d', F: '#90e050', P: '#ff8000', S: '#ffff30', Cl: '#1ff01f' };

const deg = (d: number) => (d * Math.PI) / 180;

/** Small z-matrix → Cartesian converter (bond, angle, dihedral). */
function zmatrix(rows: [string, number?, number?, number?, number?, number?, number?][]): Atom[] {
  const out: THREE.Vector3[] = [];
  const atoms: Atom[] = [];
  rows.forEach(([el, a, bond, b2, ang, c, dih], i) => {
    let p: THREE.Vector3;
    if (i === 0) p = new THREE.Vector3();
    else if (i === 1) p = new THREE.Vector3(0, 0, bond!);
    else if (i === 2) {
      const A = out[a!], B = out[b2!];
      const dir = B.clone().sub(A).normalize();
      const perp = new THREE.Vector3(1, 0, 0).cross(dir).lengthSq() > 1e-6 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const n = dir.clone().cross(perp).normalize();
      p = A.clone().add(dir.clone().applyAxisAngle(n, deg(ang!)).multiplyScalar(bond!));
    } else {
      const A = out[a!], B = out[b2!], C = out[c!];
      const bc = A.clone().sub(B).normalize();
      const n = B.clone().sub(C).cross(bc).normalize();
      const m = n.clone().cross(bc);
      const d2 = new THREE.Vector3(-bond! * Math.cos(deg(ang!)), bond! * Math.sin(deg(ang!)) * Math.cos(deg(dih!)), bond! * Math.sin(deg(ang!)) * Math.sin(deg(dih!)));
      p = A.clone().add(bc.multiplyScalar(d2.x)).add(m.multiplyScalar(d2.y)).add(n.multiplyScalar(d2.z));
    }
    out.push(p);
    atoms.push({ el, x: p.x, y: p.y, z: p.z });
  });
  return atoms;
}

const TETRA = 109.47;
export const MOLECULES: Record<string, { name: string; formula: string; atoms: () => Atom[] }> = {
  water: { name: 'Water', formula: 'H₂O', atoms: () => zmatrix([['O'], ['H', 0, 0.9572], ['H', 0, 0.9572, 1, 104.52]]) },
  methane: { name: 'Methane', formula: 'CH₄', atoms: () => zmatrix([['C'], ['H', 0, 1.087], ['H', 0, 1.087, 1, TETRA], ['H', 0, 1.087, 1, TETRA, 2, 120], ['H', 0, 1.087, 1, TETRA, 2, -120]]) },
  ammonia: { name: 'Ammonia', formula: 'NH₃', atoms: () => zmatrix([['N'], ['H', 0, 1.012], ['H', 0, 1.012, 1, 106.7], ['H', 0, 1.012, 1, 106.7, 2, 113.0]]) },
  co2: { name: 'Carbon dioxide', formula: 'CO₂', atoms: () => [{ el: 'C', x: 0, y: 0, z: 0 }, { el: 'O', x: 1.16, y: 0, z: 0 }, { el: 'O', x: -1.16, y: 0, z: 0 }] },
  ethylene: {
    name: 'Ethylene', formula: 'C₂H₄', atoms: () => {
      const cc = 1.339 / 2, ch = 1.087, a = deg(121.3);
      return [{ el: 'C', x: -cc, y: 0, z: 0 }, { el: 'C', x: cc, y: 0, z: 0 },
        ...[1, -1].flatMap((s) => [1, -1].map((side) => ({ el: 'H', x: side * (cc - ch * Math.cos(a)), y: s * ch * Math.sin(a), z: 0 })))];
    },
  },
  benzene: {
    name: 'Benzene', formula: 'C₆H₆', atoms: () => {
      const out: Atom[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        out.push({ el: 'C', x: Math.cos(a) * 1.39, y: Math.sin(a) * 1.39, z: 0 }, { el: 'H', x: Math.cos(a) * 2.48, y: Math.sin(a) * 2.48, z: 0 });
      }
      return out;
    },
  },
  ethanol: {
    name: 'Ethanol', formula: 'C₂H₅OH', atoms: () => zmatrix([
      ['C'], ['C', 0, 1.512], ['O', 1, 1.431, 0, 107.8], ['H', 2, 0.971, 1, 108.9, 0, 180],
      ['H', 0, 1.093, 1, 110.5, 2, 180], ['H', 0, 1.093, 1, 110.5, 2, 60], ['H', 0, 1.093, 1, 110.5, 2, -60],
      ['H', 1, 1.093, 0, 110.0, 2, 121], ['H', 1, 1.093, 0, 110.0, 2, -121],
    ]),
  },
};

export function parseXyz(text: string): Atom[] {
  const lines = text.split(/\r?\n/);
  const n = parseInt(lines[0] ?? '', 10);
  const out: Atom[] = [];
  for (let i = 2; i < lines.length && (Number.isNaN(n) || out.length < n); i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [el, x, y, z] = parts;
    const v = [x, y, z].map(Number);
    if (!/^[A-Z][a-z]?$/.test(el) || v.some((q) => !Number.isFinite(q))) continue;
    out.push({ el, x: v[0], y: v[1], z: v[2] });
    if (out.length > 5000) break;
  }
  return out;
}

export function bondsFor(atoms: Atom[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) {
    const a = atoms[i], b2 = atoms[j];
    const d = Math.hypot(a.x - b2.x, a.y - b2.y, a.z - b2.z);
    const lim = ((COVALENT[a.el] ?? 0.8) + (COVALENT[b2.el] ?? 0.8)) * 1.15;
    if (d > 0.4 && d < lim) out.push([i, j, d]);
  }
  return out;
}

/** XYZ text loaded by the visualization module (keyed by molecule = "file"). */
export const loadedXyz: { name: string; atoms: Atom[] } = { name: '', atoms: [] };

export const molecule: EngineDef = {
  id: 'molecule',
  name: 'Molecular Laboratory',
  description: 'Ball-and-stick molecular models with bonds detected from covalent radii.',
  artistic: false,
  science: 'Built-in geometries use experimental bond lengths and angles (e.g. H₂O: 0.9572 Å, 104.52°; benzene C–C 1.39 Å). Bonds are inferred where interatomic distance < 1.15 × sum of covalent radii. XYZ files are rendered as given. The vibration option is illustrative only.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'molecule', label: 'Molecule', type: 'select', default: 'benzene', group: 'Structure', rebuild: true, options: [...Object.entries(MOLECULES).map(([value, m]) => ({ value, label: `${m.name} (${m.formula})` })), { value: 'file', label: 'Loaded XYZ file' }] },
    { key: 'cpk', label: 'CPK element colors', type: 'bool', default: false, group: 'Look' },
    { key: 'atomScale', label: 'Atom size', type: 'number', default: 1, min: 0.2, max: 3, step: 0.05, group: 'Look', rebuild: true },
    { key: 'vibration', label: 'Vibration (illustrative)', type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Animation' },
    { key: 'spin', label: 'Rotation', type: 'number', default: 0.3, min: 0, max: 3, step: 0.01, group: 'Animation' },
    { key: 'labels', label: 'Element labels', type: 'bool', default: true, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.5, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new MoleculeEngine(ctx.params, ctx.colors);
  },
};

class MoleculeEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.1;
  private atoms: Atom[];
  private bonds: [number, number, number][];
  private atomMesh: THREE.InstancedMesh;
  private bondMesh: THREE.InstancedMesh;
  private group = new THREE.Group();
  private name: string;
  private formula: string;
  private scale = 1;
  private colors: VizColors;
  private params: Params;
  private disp: { dispose(): void }[] = [];

  constructor(params: Params, colors: VizColors) {
    this.params = params;
    this.colors = colors;
    const key = str(params, 'molecule', 'benzene');
    if (key === 'file' && loadedXyz.atoms.length) {
      this.atoms = loadedXyz.atoms;
      this.name = loadedXyz.name;
      this.formula = formulaOf(this.atoms);
    } else {
      const m = MOLECULES[key] ?? MOLECULES.benzene;
      this.atoms = m.atoms();
      this.name = m.name;
      this.formula = m.formula;
    }
    // Centre and normalise to the unit radius.
    const c = this.atoms.reduce((a, x) => [a[0] + x.x, a[1] + x.y, a[2] + x.z], [0, 0, 0]).map((v) => v / this.atoms.length);
    this.atoms = this.atoms.map((a) => ({ ...a, x: a.x - c[0], y: a.y - c[1], z: a.z - c[2] }));
    const ext = Math.max(1.2, ...this.atoms.map((a) => Math.hypot(a.x, a.y, a.z)));
    this.scale = 0.9 / ext;
    this.bonds = bondsFor(this.atoms);
    const sg = new THREE.IcosahedronGeometry(1, 3);
    const am = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 });
    this.atomMesh = new THREE.InstancedMesh(sg, am, this.atoms.length);
    const cg = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    const bm = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
    this.bondMesh = new THREE.InstancedMesh(cg, bm, Math.max(1, this.bonds.length));
    this.bondMesh.count = this.bonds.length;
    this.group.add(this.atomMesh, this.bondMesh);
    this.group.scale.setScalar(this.scale);
    this.scene.add(this.group);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key2 = new THREE.DirectionalLight(0xffffff, 1.6);
    key2.position.set(2, 3, 4);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(-3, -1, -2);
    this.scene.add(key2, rim);
    this.disp.push(sg, am, cg, bm);
    this.place(0, num(params, 'atomScale', 1), 0);
    this.paint();
  }

  private paint(): void {
    const cpk = bool(this.params, 'cpk', false);
    const col = new THREE.Color();
    this.atoms.forEach((a, i) => {
      if (cpk) col.set(CPK[a.el] ?? '#ff1493');
      else {
        const shade = a.el === 'H' ? 0.95 : a.el === 'C' ? 0.45 : a.el === 'O' ? 1.0 : 0.75;
        col.copy(this.colors.neural).lerp(this.colors.pulse, shade);
        col.multiplyScalar(0.4 + shade * 0.6);
      }
      this.atomMesh.setColorAt(i, col);
    });
    if (this.atomMesh.instanceColor) this.atomMesh.instanceColor.needsUpdate = true;
    (this.bondMesh.material as THREE.MeshStandardMaterial).color.copy(this.colors.foreground).multiplyScalar(0.55);
  }

  private place(t: number, atomScale: number, vib: number): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = this.atoms.map((a, i) => new THREE.Vector3(a.x, a.y, a.z).addScaledVector(new THREE.Vector3(Math.sin(t * 7 + i), Math.cos(t * 9 + i * 2), Math.sin(t * 8 + i * 3)), vib * 0.04));
    this.atoms.forEach((a, i) => {
      const r = (COVALENT[a.el] ?? 0.8) * (VDW_SCALE[a.el] ?? 0.85) * 0.55 * atomScale;
      m.compose(pos[i], q.identity(), new THREE.Vector3(r, r, r));
      this.atomMesh.setMatrixAt(i, m);
    });
    const up = new THREE.Vector3(0, 1, 0);
    this.bonds.forEach(([i, j], k) => {
      const a = pos[i], b2 = pos[j];
      const mid = a.clone().add(b2).multiplyScalar(0.5);
      const dir = b2.clone().sub(a);
      const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize());
      m.compose(mid, q, new THREE.Vector3(0.09, len, 0.09));
      this.bondMesh.setMatrixAt(k, m);
    });
    this.atomMesh.instanceMatrix.needsUpdate = true;
    this.bondMesh.instanceMatrix.needsUpdate = true;
  }

  setParam(key: string, _v: unknown, p: Params): boolean {
    this.params = p;
    if (key === 'cpk') this.paint();
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    this.paint();
  }

  update(dt: number, t: number, p: Params): void {
    this.group.rotation.y += dt * num(p, 'spin', 0.3);
    this.group.rotation.x = Math.sin(t * 0.1) * 0.3;
    const vib = num(p, 'vibration', 0.15);
    if (vib > 0) this.place(t, num(p, 'atomScale', 1), vib);
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    const lens = this.bonds.map((b2) => b2[2]);
    titleBlock(g, info, `MOLECULAR LABORATORY · ${this.name.toUpperCase()}`, [['FORMULA', this.formula], ['ATOMS', String(this.atoms.length)], ['BONDS', String(this.bonds.length)], ['BOND Å', lens.length ? `${Math.min(...lens).toFixed(3)}–${Math.max(...lens).toFixed(3)}` : '—']], [], w);
    if (!this.params.labels || this.atoms.length > 60) return;
    g.save();
    g.font = `9px "${info.colors.mono}", monospace`;
    g.fillStyle = info.colors.fg;
    g.globalAlpha = 0.8;
    const m = this.group.matrixWorld;
    for (const a of this.atoms) {
      const p = info.project(new THREE.Vector3(a.x, a.y, a.z).applyMatrix4(m));
      if (p.visible) g.fillText(a.el, p.x + 7, p.y - 5);
    }
    g.restore();
  }

  stats() {
    return { molecule: this.name, atoms: this.atoms.length, bonds: this.bonds.length };
  }

  gpuBytes(): number {
    return (this.atoms.length + this.bonds.length) * 80 + 60000;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
    this.atomMesh.dispose();
    this.bondMesh.dispose();
  }
}

function formulaOf(atoms: Atom[]): string {
  const counts = new Map<string, number>();
  for (const a of atoms) counts.set(a.el, (counts.get(a.el) ?? 0) + 1);
  const order = ['C', 'H', ...[...counts.keys()].filter((k) => k !== 'C' && k !== 'H').sort()];
  return order.filter((k) => counts.has(k)).map((k) => `${k}${counts.get(k)! > 1 ? counts.get(k) : ''}`).join('');
}

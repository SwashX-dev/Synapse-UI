/**
 * Geometric engines:
 *   holo          nested counter-rotating wireframe polyhedra with scanline holography,
 *                 or recursive spheres (each generation spawns children at icosahedron vertices)
 *   grid-surface  wireframe grid deformed in the vertex shader by ripples, noise and audio
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { bool, num, str } from '../types';
import { SIMPLEX } from '../glsl';
import { titleBlock } from './hud';

const HOLO_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vW;
varying float vDepth;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const HOLO_FRAG = /* glsl */ `
uniform float uTime, uAlpha, uScan, uFlicker;
uniform vec3 uCol;
varying vec3 vW;
varying float vDepth;
void main() {
  float scan = 0.65 + 0.35 * sin(vW.y * 90.0 - uTime * 6.0) * uScan;
  float band = smoothstep(0.08, 0.0, abs(fract(vW.y * 0.5 - uTime * 0.15) - 0.5)) * 0.8 * uScan;
  float flick = 1.0 - uFlicker * 0.3 * step(0.97, fract(sin(floor(uTime * 24.0)) * 43758.5));
  float fog = clamp(1.6 / max(vDepth, 0.2), 0.25, 1.0);
  gl_FragColor = vec4(uCol, (scan + band) * uAlpha * flick * fog);
}`;

export const holo: EngineDef = {
  id: 'holo',
  name: 'Holographic Geometry',
  description: 'Wireframe polyhedra and recursive spheres with holographic scanlines.',
  artistic: true,
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'shape', label: 'Structure', type: 'select', default: 'polyhedra', group: 'Structure', rebuild: true, options: [{ value: 'polyhedra', label: 'Nested polyhedra' }, { value: 'recursive', label: 'Recursive spheres' }] },
    { key: 'depth', label: 'Recursion depth', type: 'int', default: 0, min: 0, max: 5, group: 'Structure', rebuild: true, description: '0 = by quality' },
    { key: 'spin', label: 'Rotation speed', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Animation' },
    { key: 'pulse', label: 'Breathing', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Animation' },
    { key: 'scanlines', label: 'Scanlines', type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'flicker', label: 'Flicker', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'audioReactive', label: 'Audio reactive', type: 'bool', default: false, group: 'Audio' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 1.1, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new HoloEngine(ctx.quality, ctx.params, ctx.colors);
  },
};

class HoloEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.1;
  private items: { obj: THREE.Object3D; axis: THREE.Vector3; speed: number; base: number }[] = [];
  private mats: THREE.ShaderMaterial[] = [];
  private disp: { dispose(): void }[] = [];
  private shape: string;
  private count = 0;
  colors: VizColors;

  constructor(quality: number, params: Params, colors: VizColors) {
    this.colors = colors;
    this.shape = str(params, 'shape', 'polyhedra');
    const mat = (alpha: number, color: THREE.Color) => {
      const m = new THREE.ShaderMaterial({ vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, uniforms: { uTime: { value: 0 }, uAlpha: { value: alpha }, uScan: { value: 0.8 }, uFlicker: { value: 0.3 }, uCol: { value: color.clone() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      m.userData.baseAlpha = alpha;
      this.mats.push(m);
      return m;
    };
    if (this.shape === 'polyhedra') {
      const geos: THREE.BufferGeometry[] = [
        new THREE.IcosahedronGeometry(1, 0), new THREE.DodecahedronGeometry(0.82, 0), new THREE.OctahedronGeometry(0.66, 0), new THREE.BoxGeometry(0.72, 0.72, 0.72), new THREE.TetrahedronGeometry(0.5, 0),
        new THREE.IcosahedronGeometry(1.18, 1), new THREE.TorusKnotGeometry(0.28, 0.05, 160, 8, 2, 3),
      ];
      geos.forEach((g, i) => {
        const e = new THREE.EdgesGeometry(g, 1);
        const ls = new THREE.LineSegments(e, mat(i === 5 ? 0.12 : i === 6 ? 0.3 : 0.6, i % 2 ? colors.neural : colors.pulse));
        const v = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', (g as THREE.BufferGeometry).getAttribute('position')), new THREE.PointsMaterial({ color: colors.pulse, size: 0.025, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
        const grp = new THREE.Group();
        grp.add(ls);
        if (i < 5) grp.add(v);
        this.scene.add(grp);
        this.items.push({ obj: grp, axis: new THREE.Vector3(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9)).normalize(), speed: (i % 2 ? -1 : 1) * (0.15 + i * 0.07), base: 1 });
        this.disp.push(g, e, v.geometry, v.material as THREE.Material);
        this.count++;
      });
      // Orbit rings.
      for (let r = 0; r < 3; r++) {
        const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * (1.35 + r * 0.12), 0, Math.sin((i / 128) * Math.PI * 2) * (1.35 + r * 0.12)))), mat(0.18, colors.neural));
        ring.rotation.x = Math.PI / 2 + r * 0.4;
        this.scene.add(ring);
        this.items.push({ obj: ring, axis: new THREE.Vector3(0, 0, 1), speed: 0.1 * (r + 1), base: 1 });
        this.disp.push(ring.geometry);
      }
    } else {
      const depth = num(params, 'depth', 0) || [2, 3, 3, 4][quality];
      const sphereGeo = new THREE.EdgesGeometry(new THREE.SphereGeometry(1, 18, 12), 1);
      const ico = new THREE.IcosahedronGeometry(1, 0);
      const verts: THREE.Vector3[] = [];
      const pa = ico.getAttribute('position');
      for (let i = 0; i < pa.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pa, i);
        if (!verts.some((u) => u.distanceTo(v) < 1e-3)) verts.push(v);
      }
      const build = (parent: THREE.Object3D, level: number, scale: number) => {
        const grp = new THREE.Group();
        grp.scale.setScalar(scale);
        const ls = new THREE.LineSegments(sphereGeo, mat(0.5 / (level + 1), level % 2 ? colors.neural : colors.pulse));
        grp.add(ls);
        parent.add(grp);
        this.items.push({ obj: grp, axis: new THREE.Vector3(Math.sin(level * 2.1 + scale * 9), Math.cos(level * 1.3), Math.sin(level * 0.7)).normalize(), speed: (level % 2 ? -1 : 1) * (0.2 + level * 0.15), base: scale });
        this.count++;
        if (level >= depth) return;
        const inner = new THREE.Group();
        inner.scale.setScalar(0.55);
        grp.add(inner);
        build(inner, level + 1, 1);
        if (level < Math.min(2, depth - 1) || (depth <= 2 && level === 0)) {
          for (const v of verts.slice(0, level === 0 ? 12 : 6)) {
            const child = new THREE.Group();
            child.position.copy(v).multiplyScalar(1.02);
            grp.add(child);
            build(child, level + 1, 0.18);
          }
        }
      };
      build(this.scene, 0, 1);
      this.disp.push(sphereGeo, ico);
    }
    this.disp.push(...this.mats);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    this.mats.forEach((m, i) => (m.uniforms.uCol.value as THREE.Color).copy(i % 2 ? c.neural : c.pulse));
  }

  update(dt: number, t: number, p: Params, input: FrameInput): void {
    const spin = num(p, 'spin', 1);
    const audio = bool(p, 'audioReactive', false) && input.audio.active ? input.audio.bass : 0;
    for (const it of this.items) {
      it.obj.rotateOnAxis(it.axis, dt * it.speed * spin);
      const s = it.base * (1 + Math.sin(t * 0.8 + it.speed * 10) * 0.04 * num(p, 'pulse', 0.4) + audio * 0.15);
      it.obj.scale.setScalar(s);
    }
    const b2 = num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    for (const m of this.mats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uScan.value = num(p, 'scanlines', 0.8);
      m.uniforms.uFlicker.value = num(p, 'flicker', 0.3);
      m.uniforms.uAlpha.value = m.userData.baseAlpha * b2;
    }
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    titleBlock(g, info, this.shape === 'polyhedra' ? 'HOLOGRAPHIC GEOMETRY' : 'RECURSIVE SPHERE', [['ELEMENTS', String(this.count)]], [], w);
  }

  stats() {
    return { shape: this.shape, elements: this.count };
  }

  gpuBytes(): number {
    return this.count * 8000;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

// ───────────────────────────── procedural grid ─────────────────────────────

const GRID_VERT = /* glsl */ `
${SIMPLEX}
uniform float uTime, uAmp, uFreq, uRipples, uAudio, uSpeed;
uniform vec4 uDrops[4];
uniform sampler2D uSpec;
uniform float uUseSpec;
varying float vH;
varying float vEdge;
void main() {
  vec3 p = position;
  float t = uTime * uSpeed;
  float h = snoise(vec3(p.xz * uFreq, t * 0.12)) * 0.12 + snoise(vec3(p.xz * uFreq * 3.0, t * 0.2)) * 0.03;
  for (int i = 0; i < 4; i++) {
    vec4 d = uDrops[i];
    float r = length(p.xz - d.xy);
    float age = uTime - d.z;
    h += uRipples * 0.08 * sin(r * 18.0 - age * 6.0) * exp(-r * 2.5) * exp(-age * 0.6) * step(0.0, age) * smoothstep(age * 1.2 + 0.05, age * 1.2 - 0.2, r);
  }
  if (uUseSpec > 0.5) {
    float u = clamp((p.x + 1.6) / 3.2, 0.0, 1.0);
    float s = texture2D(uSpec, vec2(u, 0.5)).r;
    h += s * 0.5 * exp(-abs(p.z) * 1.5) * uAudio;
  }
  p.y += h * uAmp;
  vH = h;
  vEdge = smoothstep(1.6, 1.0, max(abs(p.x), abs(p.z)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const GRID_FRAG = /* glsl */ `
uniform vec3 uColA, uColB;
uniform float uAlpha;
varying float vH;
varying float vEdge;
void main() { gl_FragColor = vec4(mix(uColA, uColB, clamp(vH * 5.0 + 0.4, 0.0, 1.0)), (0.07 + clamp(vH * 4.0, 0.0, 1.0) * 0.35) * vEdge * uAlpha); }`;

export const gridSurface: EngineDef = {
  id: 'grid-surface',
  name: 'Procedural Grid',
  description: 'Wireframe grid deformed by noise, travelling ripples and audio spectrum.',
  artistic: true,
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'resolution', label: 'Grid lines (0 = by quality)', type: 'int', default: 0, min: 0, max: 400, group: 'Structure', rebuild: true },
    { key: 'amplitude', label: 'Amplitude', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Deformation' },
    { key: 'frequency', label: 'Noise frequency', type: 'number', default: 1.2, min: 0.1, max: 6, step: 0.01, group: 'Deformation' },
    { key: 'ripples', label: 'Ripples', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Deformation' },
    { key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Deformation' },
    { key: 'audioReactive', label: 'Audio spectrum terrain', type: 'bool', default: false, group: 'Audio' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.9, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new GridSurface(ctx.quality, ctx.params, ctx.colors);
  },
};

class GridSurface implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.3;
  private u: Record<string, THREE.IUniform>;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private spec: THREE.DataTexture;
  private specData = new Uint8Array(128 * 4);
  private nextDrop = 0;
  private dropIdx = 0;
  private lines: number;

  constructor(quality: number, params: Params, colors: VizColors) {
    this.lines = num(params, 'resolution', 0) || [60, 100, 160, 240][quality];
    const pts: number[] = [];
    const N = this.lines, S = N * 2;
    for (let i = 0; i <= N; i++) {
      const c = -1.6 + (i / N) * 3.2;
      for (let j = 0; j < S; j++) {
        const a = -1.6 + (j / S) * 3.2, b2 = -1.6 + ((j + 1) / S) * 3.2;
        pts.push(c, 0, a, c, 0, b2, a, 0, c, b2, 0, c);
      }
    }
    this.geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.spec = new THREE.DataTexture(this.specData, 128, 1, THREE.RGBAFormat);
    this.spec.needsUpdate = true;
    this.u = {
      uTime: { value: 0 }, uAmp: { value: 1 }, uFreq: { value: 1.2 }, uRipples: { value: 1 }, uAudio: { value: 0 }, uSpeed: { value: 1 }, uAlpha: { value: 1 }, uUseSpec: { value: 0 }, uSpec: { value: this.spec },
      uDrops: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -100, 0)) }, uColA: { value: colors.neural.clone() }, uColB: { value: colors.pulse.clone() },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.LineSegments(this.geo, this.mat);
    mesh.frustumCulled = false;
    mesh.position.y = -0.2;
    this.scene.add(mesh);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.u.uColA.value as THREE.Color).copy(c.neural);
    (this.u.uColB.value as THREE.Color).copy(c.pulse);
  }

  update(_dt: number, t: number, p: Params, input: FrameInput): void {
    this.u.uTime.value = t;
    this.u.uAmp.value = num(p, 'amplitude', 1);
    this.u.uFreq.value = num(p, 'frequency', 1.2);
    this.u.uRipples.value = num(p, 'ripples', 1);
    this.u.uSpeed.value = num(p, 'speed', 1);
    this.u.uAlpha.value = num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    if (t > this.nextDrop) {
      this.nextDrop = t + 1.5 + Math.random() * 2.5;
      (this.u.uDrops.value as THREE.Vector4[])[this.dropIdx++ % 4].set(Math.random() * 2.4 - 1.2, Math.random() * 2.4 - 1.2, t, 0);
    }
    const audio = bool(p, 'audioReactive', false) && input.audio.active;
    this.u.uUseSpec.value = audio ? 1 : 0;
    this.u.uAudio.value = audio ? 1 : 0;
    if (audio) {
      for (let i = 0; i < 128; i++) this.specData[i * 4] = Math.min(255, (input.audio.spectrum[i] ?? 0) * 255);
      this.spec.needsUpdate = true;
    }
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    titleBlock(g, info, 'PROCEDURAL GRID', [['LINES', String(this.lines * 2)]], [], w);
  }

  stats() {
    return { lines: this.lines * 2 };
  }

  gpuBytes(): number {
    return this.lines * this.lines * 2 * 48;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.spec.dispose();
  }
}

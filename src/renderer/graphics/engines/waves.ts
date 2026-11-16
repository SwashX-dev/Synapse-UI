/**
 * Wave Laboratory — a digital phosphor oscilloscope.
 *   fourier   partial Fourier sums (square / sawtooth / triangle) with each harmonic shown
 *   lissajous x = sin(a·t + δ), y = sin(b·t)
 *   beats     superposition of two close frequencies (envelope at |f₁ − f₂|)
 *   am / fm   amplitude / frequency modulation
 *   damped    damped harmonic oscillator x(t) = e^(−γt)·cos(ωt)
 *   audio     live waveform + log spectrum from the reactive audio source
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num, str } from '../types';
import { titleBlock } from './hud';

const N = 1024;

export const waves: EngineDef = {
  id: 'waves',
  name: 'Wave Laboratory',
  description: 'Oscilloscope with Fourier synthesis, Lissajous figures, beats, AM/FM, damping and live audio.',
  artistic: false,
  science: 'Waveforms are evaluated exactly from their defining equations (Fourier series truncated at N harmonics, showing Gibbs overshoot for square waves).',
  cameraModes: ['interactive'],
  defaultCamera: 'interactive',
  ownCamera: true,
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'fourier', group: 'Signal', options: ['fourier', 'lissajous', 'beats', 'am', 'fm', 'damped', 'audio'].map((v) => ({ value: v, label: v.toUpperCase() })) },
    { key: 'shape', label: 'Fourier target', type: 'select', default: 'square', group: 'Signal', options: [{ value: 'square', label: 'Square' }, { value: 'saw', label: 'Sawtooth' }, { value: 'triangle', label: 'Triangle' }] },
    { key: 'harmonics', label: 'Harmonics', type: 'int', default: 7, min: 1, max: 64, group: 'Signal' },
    { key: 'frequency', label: 'Frequency', type: 'number', default: 2, min: 0.1, max: 20, step: 0.01, group: 'Signal' },
    { key: 'ratioA', label: 'Lissajous a', type: 'int', default: 3, min: 1, max: 12, group: 'Signal' },
    { key: 'ratioB', label: 'Lissajous b', type: 'int', default: 2, min: 1, max: 12, group: 'Signal' },
    { key: 'detune', label: 'Beat detune', type: 'number', default: 0.12, min: 0.01, max: 2, step: 0.01, group: 'Signal' },
    { key: 'modDepth', label: 'Modulation depth', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Signal' },
    { key: 'damping', label: 'Damping γ', type: 'number', default: 0.35, min: 0, max: 3, step: 0.01, group: 'Signal' },
    { key: 'cycleModes', label: 'Cycle modes', type: 'bool', default: false, group: 'Signal' },
    { key: 'brightness', label: 'Trace brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'graticule', label: 'Graticule', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.9, min: 0, max: 3, step: 0.01, group: 'Rendering' },
    { key: 'motionBlur', label: 'Phosphor persistence', type: 'bool', default: true, group: 'Rendering' },
    { key: 'motionBlurAmount', label: 'Persistence', type: 'number', default: 0.6, min: 0, max: 0.95, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new Scope(ctx.colors);
  },
};

class Scope implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1;
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private main: THREE.BufferAttribute;
  private mainLine: THREE.Line;
  private harm: THREE.BufferAttribute;
  private harmLines: THREE.LineSegments;
  private spec: THREE.BufferAttribute;
  private specLines: THREE.LineSegments;
  private gratMat: THREE.LineBasicMaterial;
  private aspect = 1;
  private mode = 'fourier';
  private disp: { dispose(): void }[] = [];

  constructor(colors: VizColors) {
    const mk = (count: number) => {
      const a = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.main = mk(N);
    const mg = new THREE.BufferGeometry().setAttribute('position', this.main);
    this.mainLine = new THREE.Line(mg, new THREE.LineBasicMaterial({ color: colors.pulse, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.harm = mk(N * 2 * 8);
    const hg = new THREE.BufferGeometry().setAttribute('position', this.harm);
    this.harmLines = new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: colors.neural, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.spec = mk(128 * 2);
    const sg = new THREE.BufferGeometry().setAttribute('position', this.spec);
    this.specLines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.gratMat = new THREE.LineBasicMaterial({ color: colors.foreground, transparent: true, opacity: 0.12, depthWrite: false });
    const gp: number[] = [];
    for (let i = -5; i <= 5; i++) gp.push(i / 5, -0.8, 0, i / 5, 0.8, 0);
    for (let j = -4; j <= 4; j++) gp.push(-1, j / 5, 0, 1, j / 5, 0);
    for (let i = -25; i <= 25; i++) gp.push(i / 25, -0.012, 0, i / 25, 0.012, 0);
    const gg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    const grat = new THREE.LineSegments(gg, this.gratMat);
    this.scene.add(grat, this.harmLines, this.specLines, this.mainLine);
    this.disp.push(mg, hg, sg, gg, this.gratMat, this.mainLine.material as THREE.Material, this.harmLines.material as THREE.Material, this.specLines.material as THREE.Material);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    const s = Math.max(1, this.aspect / 1.25);
    this.camera.left = -s; this.camera.right = s; this.camera.top = 1; this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
  }

  setColors(c: VizColors): void {
    (this.mainLine.material as THREE.LineBasicMaterial).color.copy(c.pulse);
    (this.harmLines.material as THREE.LineBasicMaterial).color.copy(c.neural);
    (this.specLines.material as THREE.LineBasicMaterial).color.copy(c.accent);
    this.gratMat.color.copy(c.foreground);
  }

  setParam(): boolean {
    return true;
  }

  update(_dt: number, t: number, p: Params, input: FrameInput): void {
    const modes = ['fourier', 'lissajous', 'beats', 'am', 'fm', 'damped'];
    this.mode = p.cycleModes ? modes[Math.floor(t / 12) % modes.length] : str(p, 'mode', 'fourier');
    const f = num(p, 'frequency', 2);
    const m = this.main.array as Float32Array;
    const hArr = this.harm.array as Float32Array;
    const s = this.spec.array as Float32Array;
    let hv = 0;
    const amp = 0.62;
    const xAt = (i: number) => (i / (N - 1)) * 2 - 1;
    const mode = this.mode;
    if (mode === 'fourier') {
      const shape = str(p, 'shape', 'square');
      const H = Math.min(64, num(p, 'harmonics', 7));
      const terms: { k: number; a: number }[] = [];
      for (let n = 1; terms.length < H; n++) {
        if (shape === 'square' && n % 2 === 0) continue;
        if (shape === 'triangle' && n % 2 === 0) continue;
        const a = shape === 'square' ? 4 / (Math.PI * n) : shape === 'saw' ? ((n % 2 ? 1 : -1) * 2) / (Math.PI * n) : ((((n - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * n * n);
        terms.push({ k: n, a });
      }
      for (let i = 0; i < N; i++) {
        const x = xAt(i);
        const ph = (x + 1) * Math.PI * f - t * 2;
        let y = 0;
        for (const term of terms) y += term.a * (shape === 'triangle' ? Math.cos(term.k * ph) : Math.sin(term.k * ph));
        m[i * 3] = x; m[i * 3 + 1] = y * amp * 0.8; m[i * 3 + 2] = 0;
      }
      for (const [ti, term] of terms.slice(0, 8).entries()) {
        void ti;
        for (let i = 0; i < N - 1; i++) {
          for (const j of [i, i + 1]) {
            const x = xAt(j);
            const ph = (x + 1) * Math.PI * f - t * 2;
            hArr[hv * 3] = x; hArr[hv * 3 + 1] = term.a * (shape === 'triangle' ? Math.cos(term.k * ph) : Math.sin(term.k * ph)) * amp * 0.8; hArr[hv * 3 + 2] = 0;
            hv++;
          }
        }
      }
    } else if (mode === 'lissajous') {
      const a = num(p, 'ratioA', 3), b2 = num(p, 'ratioB', 2);
      const d = t * 0.4;
      for (let i = 0; i < N; i++) {
        const u = (i / (N - 1)) * Math.PI * 2;
        m[i * 3] = Math.sin(a * u + d) * amp; m[i * 3 + 1] = Math.sin(b2 * u) * amp; m[i * 3 + 2] = 0;
      }
    } else {
      const det = num(p, 'detune', 0.12), depth = num(p, 'modDepth', 0.6), gamma = num(p, 'damping', 0.35);
      for (let i = 0; i < N; i++) {
        const x = xAt(i);
        const tt = (x + 1) * 2 + t * 0.5;
        let y = 0;
        if (mode === 'beats') y = 0.5 * (Math.sin(2 * Math.PI * f * 2 * tt) + Math.sin(2 * Math.PI * (f + det) * 2 * tt));
        else if (mode === 'am') y = (1 + depth * Math.sin(2 * Math.PI * f * 0.15 * tt)) * Math.sin(2 * Math.PI * f * 3 * tt) / (1 + depth);
        else if (mode === 'fm') y = Math.sin(2 * Math.PI * f * 2 * tt + depth * 6 * Math.sin(2 * Math.PI * f * 0.3 * tt));
        else if (mode === 'damped') { const local = ((x + 1) / 2) * 8; y = Math.exp(-gamma * local) * Math.cos(2 * Math.PI * f * 0.6 * local - t); }
        else if (mode === 'audio') y = input.audio.active ? input.audio.waveform[Math.floor(((x + 1) / 2) * (input.audio.waveform.length - 1))] * 1.4 : 0;
        m[i * 3] = x; m[i * 3 + 1] = y * amp; m[i * 3 + 2] = 0;
        if (mode === 'beats' || mode === 'am') {
          const env = mode === 'beats' ? Math.abs(Math.cos(Math.PI * det * 2 * tt)) : (1 + depth * Math.sin(2 * Math.PI * f * 0.15 * tt)) / (1 + depth);
          if (i < N - 1) {
            const x2 = xAt(i + 1);
            const tt2 = (x2 + 1) * 2 + t * 0.5;
            const env2 = mode === 'beats' ? Math.abs(Math.cos(Math.PI * det * 2 * tt2)) : (1 + depth * Math.sin(2 * Math.PI * f * 0.15 * tt2)) / (1 + depth);
            for (const sign of [1, -1]) {
              hArr[hv * 3] = x; hArr[hv * 3 + 1] = sign * env * amp; hArr[hv * 3 + 2] = 0; hv++;
              hArr[hv * 3] = x2; hArr[hv * 3 + 1] = sign * env2 * amp; hArr[hv * 3 + 2] = 0; hv++;
            }
          }
        }
      }
    }
    this.harmLines.geometry.setDrawRange(0, hv);
    // Spectrum strip (audio) along the bottom.
    let sv = 0;
    if (input.audio.active) {
      for (let i = 0; i < 128; i++) {
        const x = -1 + (i / 127) * 2;
        const v = input.audio.spectrum[i] ?? 0;
        s[sv * 3] = x; s[sv * 3 + 1] = -0.95; s[sv * 3 + 2] = 0; sv++;
        s[sv * 3] = x; s[sv * 3 + 1] = -0.95 + v * 0.14; s[sv * 3 + 2] = 0; sv++;
      }
    }
    this.specLines.geometry.setDrawRange(0, sv);
    this.main.needsUpdate = true;
    this.harm.needsUpdate = true;
    this.spec.needsUpdate = true;
    const op = num(p, 'layerOpacity', 1);
    (this.mainLine.material as THREE.LineBasicMaterial).opacity = Math.min(1, num(p, 'brightness', 1)) * op;
    this.gratMat.opacity = 0.14 * num(p, 'graticule', 0.6) * op;
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    if (w < 180 || h < 110) return;
    titleBlock(g, info, `WAVE LAB · ${this.mode.toUpperCase()}`, [], [], w);
    g.save();
    g.font = `9px "${info.colors.mono}", monospace`;
    g.fillStyle = info.colors.dim;
    g.globalAlpha = 0.7;
    g.fillText('CH1  0.2 V/div   10 ms/div   TRIG AUTO', 12, h - 10);
    g.restore();
  }

  stats() {
    return { mode: this.mode, samples: N };
  }

  gpuBytes(): number {
    return N * 12 * 18;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}

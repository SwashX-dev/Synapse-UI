/**
 * Data-visualization interface: a registry of named numeric sources that any
 * module can read or bind visual parameters to.
 *
 *   live   — real measurements (monitoring, audio analysis)
 *   sim    — generated simulation data, always labelled SIMULATED
 *   file   — columns of user-chosen CSV/JSON datasets, played back over time
 *   fn     — mathematical expressions of time (see shared/expression.ts)
 */
import { METRICS, type MonitorStore } from './monitor';
import type { AudioEngine } from './audio';
import type { Dataset } from '../../shared/data';
import { tryCompile } from '../../shared/expression';

export type SourceKind = 'live' | 'sim' | 'file' | 'fn';
export interface SourceInfo { id: string; label: string; unit: string; kind: SourceKind; min: number; max: number | 'auto' }

export interface Binding { param: string; source: string; inMin: number; inMax: number; outMin: number; outMax: number; smoothing?: number }

class Lorenz {
  x = 0.1; y = 0; z = 0;
  step(dt: number) {
    for (let i = 0; i < 8; i++) {
      const h = dt / 8;
      const dx = 10 * (this.y - this.x), dy = this.x * (28 - this.z) - this.y, dz = this.x * this.y - (8 / 3) * this.z;
      this.x += dx * h; this.y += dy * h; this.z += dz * h;
    }
  }
}

export class DataSources {
  private datasets = new Map<string, { ds: Dataset; rate: number; start: number }>();
  private walk = 50;
  private lorenz = new Lorenz();
  private lastSim = performance.now();
  private t0 = performance.now();

  constructor(private monitor: MonitorStore, private audio: () => AudioEngine | null) {}

  get time(): number {
    return (performance.now() - this.t0) / 1000;
  }

  list(): SourceInfo[] {
    const out: SourceInfo[] = Object.entries(METRICS).map(([id, m]) => ({ id, label: m.label, unit: m.unit, kind: 'live' as const, min: m.min, max: m.max }));
    out.push(
      { id: 'audio.level', label: 'Audio level', unit: '', kind: 'live', min: 0, max: 1 },
      { id: 'audio.bass', label: 'Audio bass (20–250 Hz)', unit: '', kind: 'live', min: 0, max: 1 },
      { id: 'audio.mid', label: 'Audio mid (250 Hz–4 kHz)', unit: '', kind: 'live', min: 0, max: 1 },
      { id: 'audio.treble', label: 'Audio treble (4–16 kHz)', unit: '', kind: 'live', min: 0, max: 1 },
      { id: 'audio.beat', label: 'Audio beat pulse', unit: '', kind: 'live', min: 0, max: 1 },
      { id: 'sim.walk', label: 'Random walk', unit: '', kind: 'sim', min: 0, max: 100 },
      { id: 'sim.lorenz', label: 'Lorenz x(t)', unit: '', kind: 'sim', min: -20, max: 20 },
      { id: 'sim.sine', label: 'Sine 0.2 Hz', unit: '', kind: 'sim', min: -1, max: 1 },
      { id: 'sim.noise', label: 'Smooth noise', unit: '', kind: 'sim', min: 0, max: 1 },
    );
    for (const [name, d] of this.datasets) for (const col of d.ds.columns) out.push({ id: `file.${name}.${col}`, label: `${d.ds.name} · ${col}`, unit: '', kind: 'file', min: 0, max: 'auto' });
    return out;
  }

  kind(id: string): SourceKind {
    if (id.startsWith('sim.')) return 'sim';
    if (id.startsWith('file.')) return 'file';
    if (id.startsWith('fn:') || id.startsWith('=')) return 'fn';
    return 'live';
  }

  /** Subscribe to the monitoring topic a source needs (ref-counted). */
  acquire(id: string): () => void {
    if (METRICS[id]) return this.monitor.acquireMetric(id);
    if (id.startsWith('audio.')) {
      const a = this.audio();
      return a ? a.retain() : () => {};
    }
    return () => {};
  }

  private stepSim(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastSim) / 1000);
    if (dt <= 0) return;
    this.lastSim = now;
    this.walk = Math.max(0, Math.min(100, this.walk + (Math.random() - 0.5) * 40 * dt + (50 - this.walk) * 0.05 * dt));
    this.lorenz.step(dt * 0.6);
  }

  value(id: string): number | null {
    if (METRICS[id]) return this.monitor.value(id);
    if (id.startsWith('audio.')) {
      const a = this.audio();
      if (!a?.active) return 0;
      const b = a.bands;
      switch (id) {
        case 'audio.level': return b.level;
        case 'audio.bass': return b.bass;
        case 'audio.mid': return b.mid;
        case 'audio.treble': return b.treble;
        case 'audio.beat': return b.beatPulse;
      }
      return null;
    }
    if (id.startsWith('sim.')) {
      this.stepSim();
      const t = this.time;
      switch (id) {
        case 'sim.walk': return this.walk;
        case 'sim.lorenz': return this.lorenz.x;
        case 'sim.sine': return Math.sin(t * Math.PI * 2 * 0.2);
        case 'sim.noise': return 0.5 + 0.25 * Math.sin(t * 0.7) + 0.15 * Math.sin(t * 1.9 + 1) + 0.1 * Math.sin(t * 4.3 + 2);
      }
      return null;
    }
    if (id.startsWith('file.')) {
      const [, name, col] = id.split('.');
      const d = this.datasets.get(name);
      const series = d?.ds.series[col];
      if (!d || !series || !series.length) return null;
      const idx = Math.floor(((performance.now() - d.start) / 1000) * d.rate) % series.length;
      const v = series[idx];
      return Number.isFinite(v) ? v : null;
    }
    if (id.startsWith('fn:') || id.startsWith('=')) {
      const c = tryCompile(id.replace(/^(fn:|=)/, ''));
      if ('error' in c) return null;
      return c.fn(this.scope);
    }
    return null;
  }

  /** Expression scope: t (seconds), plus every source id (e.g. cpu.load, audio.bass). */
  readonly scope = (name: string): number | undefined => {
    if (name === 't' || name === 'time') return this.time;
    const v = this.value(name);
    return v === null ? undefined : v;
  };

  addDataset(name: string, ds: Dataset, rate = 4): string {
    const key = name.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 32) || 'data';
    this.datasets.set(key, { ds, rate, start: performance.now() });
    return key;
  }

  dataset(key: string): Dataset | undefined {
    return this.datasets.get(key)?.ds;
  }

  datasetKeys(): string[] {
    return [...this.datasets.keys()];
  }

  /** Map a binding's source value into its parameter range (with optional exponential smoothing). */
  resolveBinding(b: Binding, prev: number | undefined): number | undefined {
    const v = this.value(b.source);
    if (v === null) return prev;
    const span = b.inMax - b.inMin || 1;
    const n = Math.max(0, Math.min(1, (v - b.inMin) / span));
    const out = b.outMin + (b.outMax - b.outMin) * n;
    const s = b.smoothing ?? 0.85;
    return prev === undefined ? out : prev * s + out * (1 - s);
  }
}

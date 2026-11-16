/**
 * Information, graph and utility modules: event stream, telemetry, waveform,
 * data plot (JSON / CSV / expressions), rendering performance, notes, audio.
 */
import { SynModule, registerModuleType, type ModuleContext } from '../workspace/module';
import { MonitorModule } from './monitoring';
import { bridge } from '../core/bridge';
import { cssVar, fitCanvas, fmt, formatBytes, formatRate, h, Ring } from '../core/util';
import { Graph } from '../ui/graph';
import { METRICS, type ConnData, type CpuData, type MemData, type StorageItem } from '../core/monitor';
import type { MonitorTopic } from '../../shared/ipc';
import { parseCsv, parseJsonData, stats } from '../../shared/data';
import { tryCompile } from '../../shared/expression';

const base = { version: '1.0.0', author: 'SYNAPSE-UI', rendering: 'dom' as const, configSchema: [] };

// ───────────────────────── event stream ─────────────────────────

type Level = 'info' | 'warn' | 'alert' | 'sys';
export const eventLog: { t: number; level: Level; text: string }[] = [];
const eventListeners = new Set<() => void>();
export function logEvent(level: Level, text: string): void {
  eventLog.push({ t: Date.now(), level, text });
  if (eventLog.length > 500) eventLog.shift();
  for (const l of eventListeners) l();
}

class EventsModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['cpu', 'mem', 'net.connections', 'storage', 'battery'];
  private list = h('div.event-list.scroll');
  private last = { cpuHigh: 0, memHigh: 0, conns: -1, battLow: false, fullDisks: new Set<string>() };
  protected build(): void {
    this.ctx.body.append(this.list);
    const l = () => this.schedule();
    eventListeners.add(l);
    this.ctx.onDispose(() => eventListeners.delete(l));
    this.ctx.onDispose(this.ctx.app.monitor.subscribe('cpu', (d) => this.check('cpu', d)));
    this.ctx.onDispose(this.ctx.app.monitor.subscribe('mem', (d) => this.check('mem', d)));
    this.ctx.onDispose(this.ctx.app.monitor.subscribe('net.connections', (d) => this.check('conn', d)));
    this.ctx.onDispose(this.ctx.app.monitor.subscribe('storage', (d) => this.check('storage', d)));
  }
  private check(kind: string, d: unknown): void {
    const now = Date.now();
    if (kind === 'cpu') {
      const c = d as CpuData;
      if (c.load > 90 && now - this.last.cpuHigh > 30000) { this.last.cpuHigh = now; logEvent('alert', `CPU load ${c.load.toFixed(0)}% (sustained high utilisation)`); }
    } else if (kind === 'mem') {
      const m = d as MemData;
      const pct = ((m.total - m.available) / m.total) * 100;
      if (pct > 90 && now - this.last.memHigh > 60000) { this.last.memHigh = now; logEvent('alert', `Memory ${pct.toFixed(0)}% used — ${formatBytes(m.available)} available`); }
    } else if (kind === 'conn') {
      const c = d as ConnData;
      if (this.last.conns >= 0 && Math.abs(c.established - this.last.conns) >= 5) logEvent('sys', `Established connections ${this.last.conns} → ${c.established} (${c.remoteHosts} remote hosts)`);
      this.last.conns = c.established;
    } else if (kind === 'storage') {
      for (const f of d as StorageItem[]) {
        if (f.use > 95 && !this.last.fullDisks.has(f.mount)) { this.last.fullDisks.add(f.mount); logEvent('warn', `${f.mount} is ${f.use.toFixed(0)}% full`); }
      }
    }
  }
  protected render(): void {
    const items = eventLog.slice(-120).reverse();
    this.list.replaceChildren(...items.map((e) => h('div.event', { class: e.level }, h('span.t.mono', new Date(e.t).toTimeString().slice(0, 8)), h('span.l', e.level.toUpperCase()), h('span.m', e.text))));
    this.ctx.setStatus(`${eventLog.length} EVENTS`);
  }
}
registerModuleType({ manifest: { ...base, id: 'events', name: 'Event Stream', description: 'Live log of application events and real system anomalies (high CPU/RAM, connection spikes, full disks).', category: 'information', permissions: ['monitor.cpu', 'monitor.memory', 'monitor.connections', 'monitor.storage'], defaultSize: { colSpan: 1, rowSpan: 2, w: 0.2, h: 0.22 }, liveData: true }, create: (c) => new EventsModule(c) });

// ───────────────────────── telemetry ─────────────────────────

const DEFAULT_TELEMETRY = ['cpu.load', 'mem.used', 'gpu.util', 'gpu.temp', 'cpu.temp', 'net.rx', 'net.tx', 'proc.count'];
class TelemetryModule extends SynModule {
  private cells: { id: string; v: HTMLElement; spark: HTMLCanvasElement; ring: Ring }[] = [];
  private grid = h('div.telemetry');
  private releases: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  mount(): void {
    this.ctx.body.append(this.grid);
    this.rebuild();
    this.timer = setInterval(() => this.tick(), 500);
  }
  private rebuild(): void {
    for (const r of this.releases) r();
    this.releases = [];
    const data = this.ctx.app.data;
    const ids = (this.ctx.config<string[]>('sources', DEFAULT_TELEMETRY) ?? DEFAULT_TELEMETRY).slice(0, 16);
    this.cells = ids.map((id) => {
      this.releases.push(data.acquire(id));
      const info = data.list().find((s) => s.id === id);
      const v = h('span.tv', '—');
      const spark = h('canvas.spark');
      const kind = data.kind(id);
      this.grid.append(h('div.tcell', h('div.row', h('span.label.grow', (info?.label ?? id).toUpperCase()), h('span.badge', { class: kind === 'live' ? 'live' : 'sim' }, kind === 'live' ? 'LIVE' : 'SIM')), v, spark));
      return { id, v, spark, ring: METRICS[id] ? this.ctx.app.monitor.history(id) : new Ring(120) };
    });
  }
  private tick(): void {
    if (!this.ctx.visible()) return;
    const data = this.ctx.app.data;
    for (const c of this.cells) {
      const v = data.value(c.id);
      if (!METRICS[c.id] && v !== null) c.ring.push(v);
      const unit = METRICS[c.id]?.unit ?? '';
      c.v.textContent = v === null ? 'n/a' : unit === 'B/s' ? formatRate(v) : `${fmt(v, Math.abs(v) < 10 ? 2 : 1)}${unit === '%' ? '%' : unit ? ' ' + unit : ''}`;
      sparkline(c.spark, c.ring);
    }
  }
  update(): void {
    this.grid.replaceChildren();
    this.rebuild();
  }
  dispose(): void {
    for (const r of this.releases) r();
    if (this.timer) clearInterval(this.timer);
  }
}
function sparkline(c: HTMLCanvasElement, r: Ring): void {
  if (!c.isConnected || c.clientWidth < 4) return;
  fitCanvas(c);
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  if (r.count < 2) return;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < r.count; i++) { min = Math.min(min, r.at(i)); max = Math.max(max, r.at(i)); }
  if (max - min < 1e-9) { max += 1; min -= 1; }
  g.strokeStyle = cssVar(c, '--fg') || '#fff';
  g.lineWidth = window.devicePixelRatio || 1;
  g.beginPath();
  for (let i = 0; i < r.count; i++) {
    const x = (i / (r.capacity - 1)) * c.width;
    const y = c.height - ((r.at(i) - min) / (max - min)) * (c.height - 2) - 1;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
}
registerModuleType({ manifest: { ...base, id: 'telemetry', name: 'Telemetry', description: 'Dense numeric readouts with sparklines for any data sources; live and simulated values are labelled.', category: 'information', permissions: ['monitor.cpu', 'monitor.memory', 'monitor.gpu', 'monitor.network'], defaultSize: { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.22 }, liveData: true }, create: (c) => new TelemetryModule(c) });

// ───────────────────────── waveform ─────────────────────────

class WaveformModule extends SynModule {
  private canvas = h('canvas.graph');
  private ring = new Ring(600);
  private release: (() => void) | null = null;
  private raf = 0;
  private stat = h('div.row.mono.wave-stats');
  mount(): void {
    this.ctx.body.append(this.canvas, this.stat);
    this.acquire();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.ctx.visible()) this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }
  private acquire(): void {
    this.release?.();
    const src = this.ctx.config<string>('source', 'cpu.load');
    this.release = this.ctx.app.data.acquire(src);
    this.ring = new Ring(600);
    const kind = this.ctx.app.data.kind(src);
    this.ctx.setBadge(kind === 'live' ? 'live' : 'sim');
    this.ctx.setStatus((this.ctx.config<string>('label', '') || src).toUpperCase());
  }
  private draw(): void {
    const v = this.ctx.app.data.value(this.ctx.config<string>('source', 'cpu.load'));
    if (v !== null) this.ring.push(v);
    const c = this.canvas;
    if (c.clientWidth < 4) return;
    fitCanvas(c);
    const g = c.getContext('2d')!;
    const w = c.width, hh = c.height;
    g.clearRect(0, 0, w, hh);
    g.strokeStyle = cssVar(c, '--border') || '#444';
    g.globalAlpha = 0.3;
    for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo((w / 8) * i, 0); g.lineTo((w / 8) * i, hh); g.stroke(); }
    g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
    g.globalAlpha = 1;
    if (this.ring.count < 2) return;
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < this.ring.count; i++) { const x = this.ring.at(i); min = Math.min(min, x); max = Math.max(max, x); sum += x; }
    const pad = (max - min) * 0.15 || 1;
    g.strokeStyle = cssVar(c, '--fg') || '#fff';
    g.shadowColor = cssVar(c, '--glow') || '#fff';
    g.shadowBlur = 6;
    g.lineWidth = 1.3 * (window.devicePixelRatio || 1);
    g.beginPath();
    for (let i = 0; i < this.ring.count; i++) {
      const x = (i / (this.ring.capacity - 1)) * w;
      const y = hh - ((this.ring.at(i) - (min - pad)) / (max - min + pad * 2)) * hh;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
    this.stat.textContent = `MIN ${fmt(min, 2)}  MAX ${fmt(max, 2)}  MEAN ${fmt(sum / this.ring.count, 2)}  NOW ${fmt(this.ring.last(), 2)}`;
  }
  update(changed: string[]): void {
    if (changed.includes('source') || changed.includes('label')) this.acquire();
  }
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.release?.();
  }
}
registerModuleType({ manifest: { ...base, id: 'waveform', name: 'Waveform', description: 'Oscilloscope-style trace of any data source (monitoring, audio, simulation, files, expressions).', category: 'graph', permissions: ['monitor.cpu'], defaultSize: { colSpan: 1, rowSpan: 1, w: 0.2, h: 0.12 }, configSchema: [{ key: 'source', label: 'Data source', type: 'string', default: 'cpu.load' }, { key: 'label', label: 'Label', type: 'string', default: '' }] }, create: (c) => new WaveformModule(c) });

// ───────────────────────── data plot ─────────────────────────

class DataPlotModule extends SynModule {
  private canvas = h('canvas.graph');
  private info = h('div.row.mono.dim');
  private controls = h('div.row.plot-controls');
  private raf = 0;
  private fnRing = new Ring(600);
  mount(): void {
    this.ctx.body.classList.add('plot-body');
    const load = (kind: 'csv' | 'json') => async () => {
      const f = await bridge.dialog.openData(kind);
      if (!f) return;
      try {
        const text = new TextDecoder().decode(f.data);
        const ds = kind === 'csv' ? parseCsv(text, f.name) : parseJsonData(text, f.name);
        const key = this.ctx.app.data.addDataset(f.name.replace(/\.[^.]+$/, ''), ds);
        this.ctx.updateConfig({ source: 'file', dataset: key, columns: ds.columns.filter((c) => stats(ds.series[c]).count > 0).slice(0, 4) });
        this.ctx.app.overlays.toast(`Loaded ${ds.rows} rows × ${ds.columns.length} columns from ${f.name}. Sources: file.${key}.<column>`, 'ok', 6000);
      } catch (e) {
        this.ctx.app.overlays.toast(`Could not parse ${f.name}: ${(e as Error).message}`, 'error');
      }
    };
    this.controls.append(h('button', { onclick: load('csv') }, 'Load CSV'), h('button', { onclick: load('json') }, 'Load JSON'), h('button', { onclick: () => void this.editExpression() }, 'f(t)'));
    this.ctx.body.append(this.controls, this.canvas, this.info);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.ctx.visible()) this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }
  private async editExpression(): Promise<void> {
    const v = await this.ctx.app.overlays.prompt({ title: 'Plot expression', label: 'f(t) — e.g. sin(t)*exp(-0.1*t), or a source such as cpu.load*2', value: this.ctx.config<string>('expression', 'sin(t)'), validate: (x) => { const c = tryCompile(x); return 'error' in c ? c.error : null; } });
    if (v !== null) { this.fnRing = new Ring(600); this.ctx.updateConfig({ source: 'function', expression: v }); }
  }
  private draw(): void {
    const c = this.canvas;
    if (c.clientWidth < 4) return;
    fitCanvas(c);
    const g = c.getContext('2d')!;
    const w = c.width, hh = c.height, dpr = window.devicePixelRatio || 1;
    g.clearRect(0, 0, w, hh);
    const fg = cssVar(c, '--fg') || '#fff', dim = cssVar(c, '--text-dim') || '#888', border = cssVar(c, '--border') || '#444';
    const colors = [0, 1, 2, 3].map((i) => cssVar(c, `--graph-${i}`) || fg);
    const src = this.ctx.config<string>('source', 'function');
    let series: { name: string; data: ArrayLike<number>; n: number }[] = [];
    if (src === 'file') {
      const ds = this.ctx.app.data.dataset(this.ctx.config<string>('dataset', ''));
      if (ds) series = (this.ctx.config<string[]>('columns', []) ?? []).filter((col) => ds.series[col]).map((col) => ({ name: col, data: ds.series[col], n: ds.rows }));
      this.ctx.setBadge(ds ? 'live' : null, ds ? 'FILE DATA' : undefined);
      this.ctx.setStatus(ds ? ds.name.toUpperCase() : 'NO DATASET (load one)');
    } else {
      const expr = this.ctx.config<string>('expression', 'sin(t)');
      const cc = tryCompile(expr);
      if (!('error' in cc)) {
        this.fnRing.push(cc.fn(this.ctx.app.data.scope));
        const arr = new Float64Array(this.fnRing.count);
        for (let i = 0; i < arr.length; i++) arr[i] = this.fnRing.at(i);
        series = [{ name: expr, data: arr, n: this.fnRing.capacity }];
        const vars = cc.variables.filter((v2) => v2 !== 't');
        this.ctx.setBadge(vars.some((v2) => this.ctx.app.data.kind(v2) === 'live') ? 'live' : 'sim', vars.length ? undefined : 'SIMULATED f(t)');
      }
      this.ctx.setStatus(`f(t) = ${expr}`);
    }
    // axes
    const L = 34 * dpr, B = 14 * dpr;
    g.strokeStyle = border;
    g.globalAlpha = 0.5;
    g.strokeRect(L, 2, w - L - 2, hh - B - 2);
    g.globalAlpha = 1;
    let min = Infinity, max = -Infinity;
    for (const s of series) for (let i = 0; i < s.data.length; i++) { const v = s.data[i]; if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); } }
    if (!Number.isFinite(min)) { this.info.textContent = 'no numeric data'; return; }
    if (max - min < 1e-12) { max += 1; min -= 1; }
    g.fillStyle = dim;
    g.font = `${9 * dpr}px ${cssVar(c, '--font-mono') || 'monospace'}`;
    for (let k = 0; k <= 4; k++) {
      const v = min + ((max - min) * k) / 4;
      const y = hh - B - ((v - min) / (max - min)) * (hh - B - 4);
      g.fillText(v.toPrecision(3), 2, y + 3);
    }
    series.forEach((s, si) => {
      g.strokeStyle = colors[si % colors.length];
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      const n = Math.max(2, s.n);
      let started = false;
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = L + (i / (n - 1)) * (w - L - 2);
        const y = hh - B - ((v - min) / (max - min)) * (hh - B - 4);
        if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
      }
      g.stroke();
    });
    this.info.textContent = series.map((s) => s.name).join('  ·  ');
  }
  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
registerModuleType({ manifest: { ...base, id: 'dataplot', name: 'Data Plot', description: 'Plot JSON/CSV datasets or mathematical expressions; loaded columns become bindable data sources.', category: 'graph', permissions: ['data.files'], defaultSize: { colSpan: 1, rowSpan: 2, w: 0.24, h: 0.2 }, configSchema: [{ key: 'expression', label: 'Expression', type: 'string', default: 'sin(t)' }] }, create: (c) => new DataPlotModule(c) });

// ───────────────────────── performance diagnostics ─────────────────────────

class PerformanceModule extends SynModule {
  private fps = new Ring(240);
  private graph!: Graph;
  private table = h('div.kv');
  private procs = h('div.kv');
  private timer: ReturnType<typeof setInterval> | null = null;
  mount(): void {
    const g = h('div.perf-graph');
    this.graph = new Graph(g, { min: 0, max: 'auto', label: 'FPS' });
    this.ctx.body.append(g, this.table, h('div.rule'), this.procs);
    this.timer = setInterval(() => void this.tick(), 500);
  }
  private async tick(): Promise<void> {
    if (!this.ctx.visible()) return;
    const ge = this.ctx.app.graphics;
    this.fps.push(ge.fps);
    this.graph.draw([this.fps]);
    const m = ge.memoryEstimate();
    const perf = this.ctx.app.perf;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    this.table.replaceChildren(...[
      ['PROFILE', perf.profile.toUpperCase()], ['QUALITY', ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'][perf.quality]], ['TARGET', `${perf.targetFps} fps`], ['FRAME', `${perf.averageFrameMs.toFixed(1)} ms`], ['WORK', `${ge.workMs.toFixed(1)} ms`],
      ['RES SCALE', perf.renderScale.toFixed(2)], ['VIEWS', `${[...ge.views].filter((v) => v.visible()).length}/${ge.views.size}`], ['DRAW CALLS', String(m.drawCalls)], ['PROGRAMS', String(m.programs)], ['GPU MEM (EST.)', formatBytes(m.bytes)], ['JS HEAP', heap ? formatBytes(heap) : 'n/a'],
    ].flatMap(([k, v]) => [h('span.k', k), h('span.v', v)]));
    try {
      const metrics = await bridge.app.metrics();
      this.procs.replaceChildren(...metrics.flatMap((p) => [h('span.k', `${p.type}${p.name ? ` (${p.name})` : ''}`), h('span.v', `${p.cpu.toFixed(1)}% · ${formatBytes(p.memoryKB * 1024)}`)]));
    } catch { /* ignore */ }
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
registerModuleType({ manifest: { ...base, id: 'performance', name: 'Performance', description: 'Rendering FPS, frame time, quality scaling, draw calls, estimated GPU memory and per-process CPU/RAM.', category: 'utility', permissions: [], defaultSize: { colSpan: 1, rowSpan: 2, w: 0.2, h: 0.26 }, liveData: true }, create: (c) => new PerformanceModule(c) });

// ───────────────────────── notes ─────────────────────────

class NotesModule extends SynModule {
  private ta = h('textarea.notes', { spellcheck: 'false', placeholder: 'Notes for this workspace…' });
  mount(): void {
    this.ta.value = this.ctx.config<string>('text', '');
    let t: ReturnType<typeof setTimeout> | null = null;
    this.ta.addEventListener('input', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => this.ctx.updateConfig({ text: this.ta.value.slice(0, 20000) }), 600);
    });
    this.ctx.body.append(this.ta);
  }
}
registerModuleType({ manifest: { ...base, id: 'notes', name: 'Notes', description: 'A plain-text notes panel saved with the workspace.', category: 'information', permissions: [], defaultSize: { colSpan: 1, rowSpan: 1, w: 0.18, h: 0.16 } }, create: (c) => new NotesModule(c) });

// ───────────────────────── audio ─────────────────────────

class AudioModule extends SynModule {
  private canvas = h('canvas.graph');
  private status = h('div.mono.dim');
  private devices = h('select');
  private raf = 0;
  private release: (() => void) | null = null;
  mount(): void {
    const app = this.ctx.app;
    const a = app.audio;
    this.release = a.retain();
    const fileBtn = h('button', { onclick: async () => {
      const f = await bridge.dialog.openData('audio');
      if (!f) return;
      await a.playFile(f.name, f.data);
      void app.set({ 'audio.input_source': 'file', 'audio.file': f.path });
    } }, 'Audio file…');
    const micBtn = h('button', { onclick: async () => {
      await a.startMicrophone(this.devices.value || 'default');
      if (a.active) void app.set({ 'audio.input_source': 'microphone', 'audio.input_device': this.devices.value || 'default' });
    } }, 'Start input');
    const sysBtn = h('button', { onclick: async () => { await a.startSystem(); if (a.active) void app.set({ 'audio.input_source': 'system' }); } }, 'System audio');
    const stopBtn = h('button', { onclick: () => void a.stop().then(() => app.set({ 'audio.input_source': 'none' })) }, 'Stop');
    this.ctx.body.classList.add('audio-body');
    this.ctx.body.append(h('div.row.wrap', fileBtn, this.devices, micBtn, sysBtn, stopBtn), this.canvas, this.status);
    void a.inputDevices().then((list) => {
      this.devices.replaceChildren(h('option', { value: 'default' }, 'Default input'), ...list.filter((d) => d.id !== 'default').map((d) => h('option', { value: d.id }, d.label)));
      this.devices.value = app.get<string>('audio.input_device');
    });
    this.ctx.onDispose(a.events.on('state', () => this.renderStatus()));
    this.renderStatus();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.ctx.visible()) this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }
  private renderStatus(): void {
    const a = this.ctx.app.audio;
    this.ctx.setBadge(a.active ? 'live' : null);
    this.ctx.setStatus(a.active ? `${a.kind.toUpperCase()}: ${a.label}` : 'NO SOURCE');
    this.status.textContent = a.error || (a.active ? `${a.kind} · ${a.label}` : 'Choose a source. Capture only starts when you click a button (no implicit recording).');
  }
  private draw(): void {
    const a = this.ctx.app.audio;
    const c = this.canvas;
    if (c.clientWidth < 4) return;
    fitCanvas(c);
    const g = c.getContext('2d')!;
    const w = c.width, hh = c.height;
    g.clearRect(0, 0, w, hh);
    const fg = cssVar(c, '--fg') || '#fff';
    const n = a.spectrum.length;
    g.fillStyle = fg;
    for (let i = 0; i < n; i++) {
      const v = a.spectrum[i];
      const bw = w / n;
      g.globalAlpha = 0.3 + v * 0.7;
      g.fillRect(i * bw, hh * 0.62 - v * hh * 0.6, Math.max(1, bw - 1), v * hh * 0.6);
    }
    g.globalAlpha = 1;
    g.strokeStyle = fg;
    g.beginPath();
    for (let i = 0; i < a.waveform.length; i++) {
      const x = (i / (a.waveform.length - 1)) * w;
      const y = hh * 0.82 + a.waveform[i] * hh * 0.15;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    const b = a.bands;
    g.fillStyle = cssVar(c, '--text-dim') || '#888';
    g.font = `${10 * (window.devicePixelRatio || 1)}px ${cssVar(c, '--font-mono') || 'monospace'}`;
    g.fillText(`LVL ${b.level.toFixed(2)}  BASS ${b.bass.toFixed(2)}  MID ${b.mid.toFixed(2)}  TREB ${b.treble.toFixed(2)}  ${b.bpm ? `${b.bpm} BPM` : ''}${b.beatPulse > 0.6 ? '  ●' : ''}`, 6, 14 * (window.devicePixelRatio || 1));
  }
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.release?.();
  }
}
registerModuleType({ manifest: { ...base, id: 'audio', name: 'Audio Analyzer', description: 'Choose the audio-reactive source (file, input device, system audio) and view spectrum, bands and beats.', category: 'utility', permissions: ['audio.analysis'], defaultSize: { colSpan: 1, rowSpan: 1, w: 0.22, h: 0.16 } }, create: (c) => new AudioModule(c) });

export type { ModuleContext };

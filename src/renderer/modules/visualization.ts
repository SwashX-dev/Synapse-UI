/**
 * Visualization module: hosts one VizView (any engine/preset) with its own
 * camera, parameters, data bindings, frame limit and priority. Any number of
 * these can run simultaneously; all share one GPU context.
 */
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { SynModule, registerModuleType, type ModuleContext } from '../workspace/module';
import { VizView } from '../graphics/engine';
import { ENGINES } from '../graphics/engines';
import { bridge } from '../core/bridge';
import { debounce, h } from '../core/util';
import { CAMERA_MODES, type CameraMode } from '../../shared/commands';
import type { Preset } from '../../shared/manifest';
import type { Binding } from '../core/datasources';
import type { Params, ParamValue } from '../graphics/types';
import { tryCompile } from '../../shared/expression';
import { isColor } from '../../shared/settings';
import { loadedXyz, parseXyz } from '../graphics/engines/bio';

type RecFormat = 'webm' | 'gif' | 'png' | 'png-sequence' | 'mp4';

export class VisualizationModule extends SynModule {
  view: VizView | null = null;
  private wrap = h('div.viz-wrap');
  private msg = h('div.viz-msg');
  private bar = h('div.viz-bar');
  private recorder: MediaRecorder | null = null;
  private recStop: (() => void) | null = null;
  private offlineBusy = false;
  private saveParams = debounce(() => this.ctx.updateConfig({ params: { ...this.view?.userParams } }), 500);

  constructor(ctx: ModuleContext) {
    super(ctx);
  }

  mount(): void {
    const ctx = this.ctx;
    ctx.body.classList.add('flush');
    this.msg.hidden = true;
    this.wrap.append(this.msg, this.bar);
    ctx.body.append(this.wrap);
    this.buildBar();
    const preset = this.presetFromConfig();
    this.view = new VizView(ctx.app.graphics, this.wrap, {
      preset,
      params: (ctx.config<Params>('params', {}) ?? {}) as Params,
      camera: ctx.config<CameraMode | undefined>('camera', undefined),
      seed: ctx.config<number>('seed', ctx.app.get<number>('visualization.seed')),
      fpsLimit: ctx.config<number>('fpsLimit', 0),
      priority: ctx.config<number>('priority', 1),
      hud: ctx.config<boolean>('hud', true),
      bindings: ctx.config<Binding[] | undefined>('bindings', undefined),
      expressions: ctx.config<Record<string, string> | undefined>('expressions', undefined),
      layers: this.layerSpecs(),
    }, () => ctx.visible());
    this.view.events.on('built', () => this.refreshStatus());
    this.view.events.on('error', (e) => this.showMessage(`VISUALIZATION ERROR\n${e}`));
    const g = ctx.app.graphics;
    const offLost = g.events.on('lost', () => this.showMessage('GPU CONTEXT LOST — RECOVERING'));
    const offRestored = g.events.on('restored', () => this.showMessage(null));
    ctx.onDispose(offLost);
    ctx.onDispose(offRestored);
    ctx.onDispose(ctx.app.events.on('presets', () => this.refreshStatus()));
    if (!g.supported) this.showMessage(`WEBGL2 UNAVAILABLE\n${g.error}\nEnable hardware acceleration in Settings → Graphics.`);
    this.refreshStatus();
  }

  private presetFromConfig(): Preset {
    const id = this.ctx.config<string>('preset', this.ctx.app.get<string>('visualization.default_animation'));
    return this.ctx.app.preset(id) ?? this.ctx.app.preset('neural-sphere')!;
  }

  private layerSpecs(): { preset: Preset; opacity: number }[] {
    const layers = this.ctx.config<{ preset: string; opacity: number }[]>('layers', []) ?? [];
    return layers.map((l) => ({ preset: this.ctx.app.preset(l.preset), opacity: Math.max(0, Math.min(1, Number(l.opacity) || 0.5)) })).filter((l): l is { preset: Preset; opacity: number } => !!l.preset).slice(0, 3);
  }

  private buildBar(): void {
    const btn = (label: string, title: string, fn: () => void) => h('button.ghost', { title, onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label);
    this.bar.append(
      btn('◎', 'Cycle camera mode', () => this.cycleCamera()),
      btn('❚❚', 'Pause / resume this visualization', () => this.togglePlay()),
      btn('◉', 'Screenshot (PNG)', () => void this.screenshot().then((p) => this.ctx.app.overlays.toast(`Saved ${p}`, 'ok'))),
      btn('⏺', 'Record (format from Settings → Animations)', () => void this.toggleRecording().then((m) => this.ctx.app.overlays.toast(m, 'info'))),
      btn('✎', 'Animation editor', () => this.ctx.app.overlays.openAnimationEditor(this.ctx.id)),
    );
  }

  private showMessage(text: string | null): void {
    this.msg.hidden = !text;
    this.msg.textContent = text ?? '';
  }

  refreshStatus(): void {
    const v = this.view;
    if (!v) return;
    const def = ENGINES[v.preset.engine];
    this.ctx.setTitle(v.preset.name.toUpperCase());
    this.ctx.setStatus(`${(def?.name ?? v.preset.engine).toUpperCase()}${v.overLimit ? ' · SUSPENDED (LIMIT)' : ''}`);
    const sources = [...v.bindings.map((b) => b.source), ...Object.values(v.expressions).flatMap((e) => { const c = tryCompile(e); return 'error' in c ? [] : c.variables; })];
    const live = sources.some((s) => this.ctx.app.data.kind(s) === 'live') || ['topology'].includes(String(v.params.mode)) || v.preset.engine === 'encom-globe';
    const sim = sources.some((s) => this.ctx.app.data.kind(s) === 'sim');
    this.ctx.setBadge(live ? 'live' : sim ? 'sim' : null, live ? 'LIVE DATA' : undefined);
    if (!v.error) this.showMessage(null);
    void def;
  }

  // ───────── public control API (palette, commands, editor) ─────────

  loadPreset(id: string): void {
    const p = this.ctx.app.preset(id);
    if (!p || !this.view) return;
    this.view.loadPreset(p);
    this.ctx.updateConfig({ preset: id, params: {}, bindings: undefined, expressions: undefined, camera: undefined });
    this.refreshStatus();
  }

  setCamera(mode: CameraMode): void {
    this.view?.setCamera(mode);
    this.ctx.updateConfig({ camera: mode });
  }

  cycleCamera(): void {
    if (!this.view) return;
    const modes = this.view.def?.cameraModes ?? [...CAMERA_MODES];
    const i = modes.indexOf(this.view.rig.mode);
    this.setCamera(modes[(i + 1) % modes.length]);
    this.ctx.app.overlays.toast(`Camera: ${this.view.rig.mode}`, 'info', 1500);
  }

  togglePlay(): void {
    if (!this.view) return;
    this.view.playing = !this.view.playing;
    this.view.markDirty();
  }

  setParam(key: string, value: ParamValue): void {
    this.view?.setParam(key, value);
    this.saveParams();
  }

  setSeed(seed: number): void {
    this.view?.setSeed(seed);
    this.ctx.updateConfig({ seed });
  }

  setBindings(bindings: Binding[]): void {
    if (!this.view) return;
    this.view.bindings = bindings;
    this.ctx.updateConfig({ bindings });
    this.view.rebuild(true);
    this.refreshStatus();
  }

  setExpressions(expressions: Record<string, string>): void {
    if (!this.view) return;
    this.view.expressions = expressions;
    this.ctx.updateConfig({ expressions });
    this.view.rebuild(true);
    this.refreshStatus();
  }

  setLayers(layers: { preset: string; opacity: number }[]): void {
    this.ctx.updateConfig({ layers });
    this.view?.setLayers(this.layerSpecs());
  }

  setParamFromText(param: string, text: string): { ok: boolean; message: string } {
    const v = this.view;
    if (!v?.def) return { ok: false, message: 'visualization not ready' };
    const spec = v.def.params.find((p) => p.key === param);
    if (!spec) return { ok: false, message: `unknown parameter "${param}". Available: ${v.def.params.map((p) => p.key).join(', ')}` };
    const raw = text.trim();
    if (raw.startsWith('=')) {
      const c = tryCompile(raw.slice(1));
      if ('error' in c) return { ok: false, message: `expression error: ${c.error}` };
      this.setExpressions({ ...v.expressions, [param]: raw.slice(1) });
      return { ok: true, message: `${param} = ${raw.slice(1)} (expression)` };
    }
    let value: ParamValue;
    if (spec.type === 'bool') value = /^(true|on|1|yes)$/i.test(raw);
    else if (spec.type === 'number' || spec.type === 'int') {
      value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false, message: `expected a number for ${param}` };
    } else if (spec.type === 'color') {
      if (raw && !isColor(raw)) return { ok: false, message: 'expected a color' };
      value = raw;
    } else if (spec.type === 'select') {
      if (!spec.options?.some((o) => o.value === raw)) return { ok: false, message: `expected one of ${spec.options?.map((o) => o.value).join(', ')}` };
      value = raw;
    } else value = raw;
    if (v.expressions[param]) {
      const { [param]: _drop, ...rest } = v.expressions;
      void _drop;
      this.setExpressions(rest);
    }
    this.setParam(param, value);
    return { ok: true, message: `${param} = ${JSON.stringify(value)}` };
  }

  async loadXyzFile(): Promise<void> {
    const f = await bridge.dialog.openData('xyz');
    if (!f) return;
    const atoms = parseXyz(new TextDecoder().decode(f.data));
    if (!atoms.length) {
      this.ctx.app.overlays.toast('No atoms found in that XYZ file', 'error');
      return;
    }
    loadedXyz.name = f.name.replace(/\.xyz$/i, '');
    loadedXyz.atoms = atoms;
    this.setParam('molecule', 'file');
    this.view?.rebuild(true);
  }

  // ───────── capture ─────────

  private stamp(): string {
    return `${(this.view?.preset.id ?? 'viz')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  }

  async screenshot(): Promise<string> {
    if (!this.view) throw new Error('visualization not ready');
    const png = await this.view.screenshotPng();
    this.ctx.app.sounds.play('granted', 0.5);
    return bridge.capture.save(`${this.stamp()}.png`, 'image', png);
  }

  get recording(): boolean {
    return !!this.recorder || this.offlineBusy;
  }

  async toggleRecording(format?: RecFormat): Promise<string> {
    if (this.recStop) {
      this.recStop();
      return 'stopping recording…';
    }
    const app = this.ctx.app;
    const fmt = format ?? (app.get<string>('recording.format') as RecFormat);
    const fps = app.get<number>('recording.fps');
    const duration = app.get<number>('recording.duration');
    const quality = app.get<number>('recording.quality');
    const width = app.get<number>('recording.width');
    const height = app.get<number>('recording.height');
    const view = this.view;
    if (!view) throw new Error('visualization not ready');
    if (fmt === 'png') return `saved ${await this.screenshot()}`;
    if (fmt === 'webm') {
      const stream = view.canvas.captureStream(fps);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(4e6 + quality * 26e6) });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.start(250);
      this.recorder = rec;
      this.ctx.frame.classList.add('recording');
      const timer = setTimeout(() => this.recStop?.(), duration * 1000);
      this.recStop = () => { clearTimeout(timer); if (rec.state !== 'inactive') rec.stop(); };
      void done.then(async () => {
        this.recorder = null;
        this.recStop = null;
        this.ctx.frame.classList.remove('recording');
        for (const t of stream.getTracks()) t.stop();
        const blob = new Blob(chunks, { type: 'video/webm' });
        const path = await bridge.capture.save(`${this.stamp()}.webm`, 'video', new Uint8Array(await blob.arrayBuffer()));
        app.overlays.toast(`Recording saved: ${path}`, 'ok', 7000);
      });
      return `recording WebM for up to ${duration}s (press again to stop)`;
    }
    // Offline deterministic formats.
    const frames = Math.max(1, Math.round(duration * fps));
    let stop = false;
    this.recStop = () => (stop = true);
    this.offlineBusy = true;
    this.ctx.frame.classList.add('recording');
    const run = async () => {
      try {
        if (fmt === 'gif') {
          const gif = GIFEncoder();
          const gw = Math.min(width || 640, 960), gh = Math.min(height || Math.round(gw * (view.canvas.height / view.canvas.width)), 720);
          const n = await view.renderOffline({ width: gw, height: gh, fps: Math.min(fps, 30), frames: Math.min(frames, 600), format: 'rgba' }, async (_i, rgba, w, hh) => {
            const palette = quantize(rgba, Math.round(64 + quality * 192));
            gif.writeFrame(applyPalette(rgba, palette), w, hh, { palette, delay: Math.round(1000 / Math.min(fps, 30)) });
          }, () => stop);
          gif.finish();
          const path = await bridge.capture.save(`${this.stamp()}.gif`, 'video', gif.bytes());
          app.overlays.toast(`GIF saved (${n} frames): ${path}`, 'ok', 7000);
        } else {
          const seq = await bridge.capture.beginSequence(this.stamp());
          const n = await view.renderOffline({ width, height, fps, frames, format: 'png' }, async (i, png) => {
            await bridge.capture.frame(seq.id, i, png);
          }, () => stop);
          const r = await bridge.capture.endSequence(seq.id, { encode: fmt === 'mp4' ? 'mp4' : 'none', fps, quality });
          if (r.error) app.overlays.toast(`${n} frames in ${r.dir}; ${r.error}`, 'warn', 9000);
          else app.overlays.toast(r.video ? `MP4 saved: ${r.video}` : `${n} PNG frames saved to ${r.dir}`, 'ok', 7000);
        }
      } catch (e) {
        app.overlays.toast(`Recording failed: ${(e as Error).message}`, 'error');
      } finally {
        this.offlineBusy = false;
        this.recStop = null;
        this.ctx.frame.classList.remove('recording');
      }
    };
    void run();
    return `rendering ${frames} frames offline as ${fmt.toUpperCase()}…`;
  }

  // ───────── lifecycle ─────────

  update(changed: string[]): void {
    const v = this.view;
    if (!v) return;
    if (changed.includes('preset')) {
      const p = this.presetFromConfig();
      if (p.id !== v.preset.id) v.loadPreset(p);
    }
    if (changed.includes('fpsLimit')) v.fpsLimit = this.ctx.config<number>('fpsLimit', 0);
    if (changed.includes('priority')) v.priority = this.ctx.config<number>('priority', 1);
    if (changed.includes('hud')) v.hud = this.ctx.config<boolean>('hud', true);
    if (changed.includes('camera')) {
      const cam = this.ctx.config<CameraMode | undefined>('camera', undefined);
      if (cam && cam !== v.rig.mode) v.setCamera(cam);
    }
    v.markDirty();
    this.refreshStatus();
  }

  onTheme(): void {
    this.view?.setTheme(this.ctx.theme());
  }

  onConfig(changed: string[]): void {
    if (!this.view) return;
    if (changed.some((k) => k.startsWith('visualization.glow') || k.startsWith('visualization.motion') || k === 'performance.mode')) this.view.applyPostSettings();
    if (changed.includes('visualization.quality') || changed.includes('performance.mode')) this.view.rebuild();
    if (changed.includes('graphics.resolution_scale')) this.view.resize();
    this.view.markDirty();
  }

  resize(): void {
    this.view?.resize();
  }

  pause(): void {
    this.refreshStatus();
  }

  resume(): void {
    this.view?.markDirty();
    this.refreshStatus();
  }

  focus(): void {
    this.view?.canvas.focus({ preventScroll: true });
  }

  dispose(): void {
    this.recStop?.();
    this.saveParams.flush();
    this.view?.dispose();
    this.view = null;
  }
}

registerModuleType({
  manifest: {
    id: 'visualization',
    name: 'Visualization',
    version: '1.0.0',
    description: 'Any of the 36 animation presets across 15 GPU rendering engines, with its own camera, parameters and data bindings.',
    author: 'SYNAPSE-UI',
    category: 'visualization',
    permissions: ['audio.analysis', 'monitor.cpu', 'monitor.network', 'monitor.connections'],
    rendering: 'webgl2',
    defaultSize: { colSpan: 2, rowSpan: 3, w: 0.32, h: 0.36 },
    configSchema: [
      { key: 'preset', label: 'Preset', type: 'string', default: 'neural-sphere' },
      { key: 'fpsLimit', label: 'Frame limit (0 = global)', type: 'int', default: 0, min: 0, max: 240 },
      { key: 'priority', label: 'Render priority', type: 'int', default: 1, min: 0, max: 10, description: 'Higher priority modules keep animating when the simultaneous limit is reached.' },
      { key: 'hud', label: 'Show HUD', type: 'bool', default: true },
      { key: 'chrome', label: 'Show frame and title', type: 'bool', default: true },
    ],
  },
  create: (ctx) => new VisualizationModule(ctx),
});

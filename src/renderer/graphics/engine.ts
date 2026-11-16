/**
 * Shared graphics engine.
 *
 * ONE WebGL2 context (THREE.WebGLRenderer on an offscreen canvas) renders every
 * visualization module. Each view renders into the shared drawing buffer at
 * its own size and is copied (GPU→GPU drawImage) into the module's own 2D
 * canvas, so modules layer correctly with the DOM (terminals over spheres) and
 * share compiled shader programs, without hitting Chromium's ~16-context limit.
 *
 * The scheduler enforces global and per-view frame limits, suspends hidden
 * views, caps the number of simultaneously animated views by priority, gives
 * each view a time budget (slow views are throttled, not the whole UI) and
 * feeds measured frame times to the adaptive performance manager.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { App } from '../core/app';
import type { Quality } from '../core/perf';
import type { CameraMode } from '../../shared/commands';
import type { Preset } from '../../shared/manifest';
import type { Theme } from '../../shared/theme';
import { tryCompile } from '../../shared/expression';
import { CameraRig } from './camera';
import { ENGINES } from './engines';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, ParamValue, Params, SharedResources, VizColors } from './types';
import type { Binding } from '../core/datasources';
import { Emitter } from '../core/util';

const MAX_CANVAS = 4096;

class Shared implements SharedResources {
  private items = new Map<string, { v: unknown; refs: number; dispose: (v: unknown) => void }>();
  get<T>(key: string, make: () => T, dispose: (v: T) => void): T {
    let it = this.items.get(key);
    if (!it) {
      it = { v: make(), refs: 0, dispose: dispose as (v: unknown) => void };
      this.items.set(key, it);
    }
    it.refs++;
    return it.v as T;
  }
  release(key: string): void {
    const it = this.items.get(key);
    if (!it) return;
    if (--it.refs <= 0) {
      it.dispose(it.v);
      this.items.delete(key);
    }
  }
  get size(): number {
    return this.items.size;
  }
}

export function vizColors(theme: Theme): VizColors {
  const c = (s: string) => new THREE.Color().setStyle(s.startsWith('rgba') ? s.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgb($1,$2,$3)') : s);
  return {
    background: c(theme.colors.background),
    foreground: c(theme.colors.foreground),
    neural: c(theme.colors.neural),
    pulse: c(theme.colors.neural_pulse),
    particle: c(theme.colors.particle),
    accent: c(theme.colors.accent),
    glow: c(theme.colors.glow),
    graph: theme.colors.graph.map(c),
    css: { fg: theme.colors.foreground, dim: theme.colors.text_dim, text: theme.colors.text, accent: theme.colors.accent, bg: theme.colors.background, font: theme.typography.ui_font, mono: theme.typography.mono_font },
  };
}

export class GraphicsEngine {
  readonly events = new Emitter<{ frame: []; lost: []; restored: [] }>();
  renderer: THREE.WebGLRenderer | null = null;
  readonly canvas: HTMLCanvasElement;
  readonly shared = new Shared();
  readonly views = new Set<VizView>();
  paused = false;
  lost = false;
  supported = true;
  error = '';
  fps = 0;
  workMs = 0;
  lastFrameAt = 0;
  private frames = 0;
  private fpsT = performance.now();
  private raf = 0;
  private lastTick = 0;
  private canvasSize = { w: 1, h: 1 };
  private antialias: boolean;
  private power: WebGLPowerPreference;

  constructor(readonly app: App) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.antialias = app.get<boolean>('graphics.antialias');
    this.power = app.get<WebGLPowerPreference>('graphics.power_preference');
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.events.emit('lost');
      void window.synapse.app.log('warn', 'WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      void window.synapse.app.log('info', 'WebGL context restored; rebuilding visualizations');
      for (const v of this.views) v.rebuild(true);
      this.events.emit('restored');
    });
    this.createRenderer();
    app.events.on('config', (changed) => {
      if (changed.includes('graphics.antialias') || changed.includes('graphics.power_preference')) this.reinitialize();
    });
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private createRenderer(): void {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, powerPreference: this.power, preserveDrawingBuffer: false, stencil: false, depth: true });
      this.renderer.setPixelRatio(1);
      this.renderer.autoClear = true;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.supported = true;
    } catch (e) {
      this.renderer = null;
      this.supported = false;
      this.error = (e as Error).message || 'WebGL2 is unavailable';
      void window.synapse.app.log('error', `WebGL2 unavailable: ${this.error}`);
    }
  }

  get msaa(): boolean {
    return this.antialias && this.app.perf.spec.msaa;
  }

  /** Recreate the GL context (antialias / GPU preference changes). */
  reinitialize(): void {
    this.antialias = this.app.get<boolean>('graphics.antialias');
    this.power = this.app.get<WebGLPowerPreference>('graphics.power_preference');
    for (const v of this.views) v.teardown();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    const replacement = document.createElement('canvas');
    (this as { canvas: HTMLCanvasElement }).canvas = replacement;
    this.canvasSize = { w: 1, h: 1 };
    this.createRenderer();
    for (const v of this.views) v.rebuild(true);
  }

  ensureCanvas(w: number, h: number): void {
    if (!this.renderer) return;
    if (w <= this.canvasSize.w && h <= this.canvasSize.h) return;
    const nw = Math.min(MAX_CANVAS, Math.max(this.canvasSize.w, Math.ceil(w / 64) * 64));
    const nh = Math.min(MAX_CANVAS, Math.max(this.canvasSize.h, Math.ceil(h / 64) * 64));
    this.renderer.setSize(nw, nh, false);
    this.canvasSize = { w: nw, h: nh };
  }

  get bufferHeight(): number {
    return this.canvasSize.h;
  }

  register(v: VizView): void {
    this.views.add(v);
  }
  unregister(v: VizView): void {
    this.views.delete(v);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    for (const v of this.views) v.markDirty();
  }

  private loop(now: number): void {
    this.raf = requestAnimationFrame(this.loop);
    if (this.lost || !this.renderer) return;
    const target = this.app.perf.targetFps;
    const minInterval = 1000 / target;
    if (now - this.lastTick < minInterval - 1.5) return;
    const interval = now - (this.lastTick || now);
    this.lastTick = now;
    if (document.hidden) return;
    this.app.audio.update(now);
    const t0 = performance.now();
    const suspend = this.app.get<boolean>('performance.suspend_hidden');
    const limit = this.app.get<number>('performance.max_active_visualizations');
    const candidates = [...this.views].filter((v) => v.ready && (!suspend || v.visible()));
    candidates.sort((a, b) => b.priority - a.priority || b.area - a.area);
    candidates.forEach((v, i) => (v.overLimit = i >= limit));
    for (const v of this.views) if (!candidates.includes(v)) v.overLimit = false;
    let rendered = 0;
    for (const v of candidates) {
      if (v.overLimit) continue;
      if (v.due(now, target) || v.dirty) {
        v.render(now);
        rendered++;
      }
    }
    this.workMs = performance.now() - t0;
    if (rendered) this.app.perf.reportFrame(interval, this.workMs);
    this.frames++;
    if (now - this.fpsT >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsT);
      this.frames = 0;
      this.fpsT = now;
    }
    this.lastFrameAt = now;
    this.events.emit('frame');
  }

  /** Approximate GPU memory: render targets of all views + engine buffers + three's texture count. */
  memoryEstimate(): { bytes: number; geometries: number; textures: number; programs: number; drawCalls: number; triangles: number; lines: number; points: number } {
    const info = this.renderer?.info;
    let bytes = this.canvasSize.w * this.canvasSize.h * 8;
    for (const v of this.views) bytes += v.gpuBytes();
    return {
      bytes,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      programs: info?.programs?.length ?? 0,
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      lines: info?.render.lines ?? 0,
      points: info?.render.points ?? 0,
    };
  }

  /** Simulate a context loss + restore (diagnostics / tests). */
  testContextLoss(): boolean {
    const ext = this.renderer?.getContext().getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 600);
    return true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const v of [...this.views]) v.dispose();
    this.renderer?.dispose();
  }
}

// ───────────────────────────────────────────────────────────────────────────

export interface ViewOptions {
  preset: Preset;
  params?: Params;
  camera?: CameraMode;
  seed?: number;
  fpsLimit?: number;
  priority?: number;
  hud?: boolean;
  bindings?: Binding[];
  expressions?: Record<string, string>;
  layers?: { preset: Preset; opacity: number }[];
}

interface Layer { def: EngineDef; inst: EngineInstance; pass: RenderPass; opacity: number; preset: Preset; params: Params }

/** One visualization surface (owned by a visualization module). */
export class VizView {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly rig: CameraRig;
  def: EngineDef | null = null;
  inst: EngineInstance | null = null;
  preset: Preset;
  params: Params = {};
  userParams: Params;
  bindings: Binding[];
  expressions: Record<string, string>;
  seed: number;
  priority: number;
  fpsLimit: number;
  hud: boolean;
  ready = false;
  building = false;
  error = '';
  dirty = true;
  overLimit = false;
  time = 0;
  playing = true;
  speed = 1;
  timelineEnabled = true;
  lastRender = 0;
  renderMs = 0;
  fps = 0;
  private fpsFrames = 0;
  private fpsT = performance.now();
  private slowCount = 0;
  private throttle = 1;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private afterimage: AfterimagePass | null = null;
  private layers: Layer[] = [];
  private layerSpecs: { preset: Preset; opacity: number }[];
  private size = { w: 1, h: 1 };
  private pointer = { x: 0, y: 0, inside: false, down: false };
  private ndc = new THREE.Vector2();
  private bound = new Map<string, number>();
  private releases: (() => void)[] = [];
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver;
  private colors: VizColors;
  private overrideSize: { w: number; h: number } | null = null;
  readonly events = new Emitter<{ built: []; error: [string]; frame: [] }>();

  constructor(private engine: GraphicsEngine, private container: HTMLElement, opts: ViewOptions, private visibleFn: () => boolean) {
    this.preset = opts.preset;
    this.userParams = { ...(opts.params ?? {}) };
    this.bindings = opts.bindings ?? opts.preset.bindings ?? [];
    this.expressions = { ...(opts.preset.expressions ?? {}), ...(opts.expressions ?? {}) };
    this.seed = opts.seed ?? engine.app.get<number>('visualization.seed');
    this.priority = opts.priority ?? 1;
    this.fpsLimit = opts.fpsLimit ?? 0;
    this.hud = opts.hud ?? true;
    this.layerSpecs = opts.layers ?? [];
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viz-canvas';
    this.canvas.tabIndex = 0;
    container.append(this.canvas);
    this.g = this.canvas.getContext('2d', { alpha: false, desynchronized: false })!;
    this.rig = new CameraRig(this.canvas);
    this.rig.setMode(opts.camera ?? (opts.preset.camera as CameraMode) ?? 'orbital', true);
    this.colors = vizColors(engine.app.activeTheme);
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.x = (e.clientX - r.left) / r.width;
      this.pointer.y = (e.clientY - r.top) / r.height;
      this.pointer.inside = true;
    });
    this.canvas.addEventListener('pointerleave', () => (this.pointer.inside = false));
    this.canvas.addEventListener('pointerdown', () => (this.pointer.down = true));
    this.canvas.addEventListener('pointerup', () => (this.pointer.down = false));
    this.canvas.addEventListener('dblclick', () => this.setCamera(this.rig.mode === 'interactive' ? (this.def?.defaultCamera ?? 'orbital') : 'interactive'));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    engine.register(this);
    this.resize();
    void this.build();
  }

  get area(): number {
    return this.size.w * this.size.h;
  }

  visible(): boolean {
    return this.visibleFn() && this.canvas.isConnected;
  }

  markDirty(): void {
    this.dirty = true;
  }

  due(now: number, globalFps: number): boolean {
    if (!this.playing && !this.dirty) return false;
    const limit = Math.min(globalFps, this.fpsLimit > 0 ? this.fpsLimit : globalFps) / this.throttle;
    return now - this.lastRender >= 1000 / limit - 1.5;
  }

  gpuBytes(): number {
    const px = this.size.w * this.size.h;
    let b = this.composer ? px * 8 * 2 : 0;
    if (this.bloom?.enabled) b += px * 8 * 1.4;
    if (this.afterimage?.enabled) b += px * 8 * 2;
    for (const l of this.layers) b += l.inst.gpuBytes();
    return b;
  }

  // ───────────────────────── building ─────────────────────────

  private effectiveParams(def: EngineDef, preset: Preset, user: Params): Params {
    const p: Params = {};
    for (const s of def.params) p[s.key] = s.default;
    Object.assign(p, preset.params, user);
    return p;
  }

  async build(): Promise<void> {
    const renderer = this.engine.renderer;
    if (!renderer) {
      this.error = this.engine.error || 'WebGL2 is not available on this system';
      this.events.emit('error', this.error);
      return;
    }
    this.building = true;
    this.teardown();
    const def = ENGINES[this.preset.engine];
    if (!def) {
      this.error = `unknown engine "${this.preset.engine}"`;
      this.building = false;
      this.events.emit('error', this.error);
      return;
    }
    this.def = def;
    this.params = this.effectiveParams(def, this.preset, this.userParams);
    const q = this.quality();
    try {
      const inst = await def.create({ renderer, quality: q, seed: this.seed, params: this.params, colors: this.colors, width: this.size.w, height: this.size.h, shared: this.engine.shared });
      this.inst = inst;
      inst.resize?.(this.size.w, this.size.h);
      this.rig.setRadius(inst.radius);
      const layers: Layer[] = [];
      for (const spec of this.layerSpecs) {
        const ldef = ENGINES[spec.preset.engine];
        if (!ldef) continue;
        const lp = this.effectiveParams(ldef, spec.preset, {});
        const linst = await ldef.create({ renderer, quality: q, seed: this.seed + layers.length + 1, params: lp, colors: this.colors, width: this.size.w, height: this.size.h, shared: this.engine.shared });
        layers.push({ def: ldef, inst: linst, pass: null as unknown as RenderPass, opacity: spec.opacity, preset: spec.preset, params: lp });
      }
      this.setupComposer(layers);
      this.acquireBindings();
      this.error = '';
      this.ready = true;
      this.dirty = true;
      this.events.emit('built');
    } catch (e) {
      console.error(e);
      this.error = (e as Error).message;
      this.events.emit('error', this.error);
    } finally {
      this.building = false;
    }
  }

  private setupComposer(layers: Layer[]): void {
    const renderer = this.engine.renderer!;
    const { w, h } = this.renderSize();
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: this.engine.msaa ? 4 : 0 });
    const composer = new EffectComposer(renderer, rt);
    composer.renderToScreen = true;
    const cam = this.inst!.camera ?? this.rig.camera;
    this.renderPass = new RenderPass(this.inst!.scene, cam);
    composer.addPass(this.renderPass);
    for (const l of layers) {
      const pass = new RenderPass(l.inst.scene, l.inst.camera ?? this.rig.camera);
      pass.clear = false;
      pass.clearDepth = true;
      l.pass = pass;
      composer.addPass(pass);
    }
    this.layers = [{ def: this.def!, inst: this.inst!, pass: this.renderPass, opacity: 1, preset: this.preset, params: this.params }, ...layers];
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.6);
    composer.addPass(this.bloom);
    this.afterimage = new AfterimagePass(0.75);
    composer.addPass(this.afterimage);
    composer.addPass(new OutputPass());
    composer.setSize(w, h);
    this.composer = composer;
    this.applyPostSettings();
  }

  private acquireBindings(): void {
    for (const r of this.releases) r();
    this.releases = [];
    const app = this.engine.app;
    const sources = new Set(this.bindings.map((b) => b.source));
    for (const expr of Object.values(this.expressions)) {
      const c = tryCompile(expr);
      if (!('error' in c)) for (const v of c.variables) sources.add(v);
    }
    for (const s of sources) this.releases.push(app.data.acquire(s));
    if (this.def?.params.some((p) => p.key === 'audioReactive') || [...sources].some((s) => s.startsWith('audio.'))) this.releases.push(app.audio.retain());
  }

  /** Release GPU resources (keeps configuration). */
  teardown(): void {
    this.ready = false;
    for (const l of this.layers) {
      try { l.inst.dispose(); } catch (e) { console.error(e); }
    }
    if (!this.layers.length) this.inst?.dispose();
    this.layers = [];
    this.inst = null;
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) (p as { dispose?: () => void }).dispose?.();
      this.composer = null;
    }
    this.bloom = null;
    this.afterimage = null;
  }

  rebuild(immediate = false): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    if (immediate) void this.build();
    else this.rebuildTimer = setTimeout(() => void this.build(), 250);
  }

  quality(): Quality {
    return this.engine.app.perf.quality;
  }

  applyPostSettings(): void {
    const app = this.engine.app;
    const glow = app.get<boolean>('visualization.glow') && app.perf.spec.bloom && Number(this.params.bloom ?? 1) > 0;
    if (this.bloom) {
      this.bloom.enabled = glow;
      this.bloom.strength = Number(this.params.bloom ?? 0.6) * 0.75 * app.get<number>('visualization.glow_strength');
      this.bloom.radius = Number(this.params.bloomRadius ?? 0.4);
      this.bloom.threshold = Number(this.params.bloomThreshold ?? 0.55);
    }
    if (this.afterimage) {
      const mb = app.get<boolean>('visualization.motion_blur') || this.params.motionBlur === true;
      this.afterimage.enabled = mb;
      this.afterimage.uniforms.damp.value = Math.min(0.98, typeof this.params.motionBlurAmount === 'number' ? this.params.motionBlurAmount : app.get<number>('visualization.motion_blur_amount'));
    }
    this.markDirty();
  }

  // ───────────────────────── live control ─────────────────────────

  setParam(key: string, value: ParamValue): void {
    this.userParams[key] = value;
    this.params[key] = value;
    if (['bloom', 'bloomRadius', 'bloomThreshold', 'motionBlur', 'motionBlurAmount'].includes(key)) return this.applyPostSettings();
    const spec = this.def?.params.find((p) => p.key === key);
    const handled = this.inst?.setParam?.(key, value, this.params) ?? !spec?.rebuild;
    if (spec?.rebuild || handled === false) this.rebuild();
    this.markDirty();
  }

  resetParams(): void {
    this.userParams = {};
    this.rebuild(true);
  }

  loadPreset(p: Preset, keepCamera = false): void {
    this.preset = p;
    this.userParams = {};
    this.bindings = p.bindings ?? [];
    this.expressions = { ...(p.expressions ?? {}) };
    this.time = 0;
    if (!keepCamera) this.rig.setMode((p.camera as CameraMode) ?? ENGINES[p.engine]?.defaultCamera ?? 'orbital');
    this.rebuild(true);
  }

  setLayers(specs: { preset: Preset; opacity: number }[]): void {
    this.layerSpecs = specs;
    this.rebuild(true);
  }

  setCamera(mode: CameraMode): void {
    if (this.def && !this.def.cameraModes.includes(mode)) mode = this.def.defaultCamera;
    this.rig.setMode(mode);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.rebuild(true);
  }

  restart(): void {
    this.time = 0;
    this.rebuild(true);
  }

  setTheme(theme: Theme): void {
    this.colors = vizColors(theme);
    for (const l of this.layers) l.inst.setColors(this.colors);
    this.markDirty();
  }

  // ───────────────────────── sizing & rendering ─────────────────────────

  private renderSize(): { w: number; h: number } {
    if (this.overrideSize) return this.overrideSize;
    const scale = (window.devicePixelRatio || 1) * this.engine.app.perf.renderScale;
    const w = Math.max(2, Math.min(4096, Math.round(this.container.clientWidth * scale)));
    const h = Math.max(2, Math.min(4096, Math.round(this.container.clientHeight * scale)));
    return { w, h };
  }

  resize(): void {
    const { w, h } = this.renderSize();
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.canvas.width = w;
    this.canvas.height = h;
    this.rig.setAspect(w / h);
    this.composer?.setSize(w, h);
    for (const l of this.layers) l.inst.resize?.(w, h);
    this.markDirty();
  }

  private input(): FrameInput {
    const app = this.engine.app;
    const a = app.audio;
    return {
      audio: { ...a.bands, spectrum: a.spectrum, waveform: a.waveform, active: a.active },
      pointer: this.pointer,
      quality: this.quality(),
      data: (id) => app.data.value(id),
      topic: (name) => app.monitor.get(name as never),
      width: this.size.w,
      height: this.size.h,
    };
  }

  /** Bindings and expressions → parameter values for this frame. */
  private modulate(): void {
    const app = this.engine.app;
    for (const b of this.bindings) {
      const v = app.data.resolveBinding(b, this.bound.get(b.param));
      if (v === undefined) continue;
      this.bound.set(b.param, v);
      this.applyModulated(b.param, v);
    }
    for (const [key, expr] of Object.entries(this.expressions)) {
      const c = tryCompile(expr);
      if ('error' in c) continue;
      const v = c.fn((n) => (n === 't' ? this.time : app.data.scope(n)));
      this.applyModulated(key, v);
    }
    const tl = this.preset.timeline;
    if (tl && this.timelineEnabled && tl.tracks.length) {
      const t = tl.loop ? this.time % tl.duration : Math.min(this.time, tl.duration);
      for (const track of tl.tracks) {
        const v = sampleTrack(track.keys, t);
        if (v !== null) this.applyModulated(track.param, v);
      }
    }
  }

  private applyModulated(key: string, v: number): void {
    if (key.startsWith('camera.')) return;
    const spec = this.def?.params.find((p) => p.key === key);
    if (!spec || spec.rebuild) return;
    const clamped = spec.min !== undefined && spec.max !== undefined ? Math.max(spec.min, Math.min(spec.max, v)) : v;
    if (this.params[key] === clamped) return;
    this.params[key] = clamped;
    this.inst?.setParam?.(key, clamped, this.params);
  }

  render(now: number): void {
    const renderer = this.engine.renderer;
    if (!this.ready || !this.inst || !this.composer || !renderer) return;
    const t0 = performance.now();
    const rawDt = this.lastRender ? Math.min(0.1, (now - this.lastRender) / 1000) : 1 / 60;
    this.lastRender = now;
    const dt = this.playing && !this.engine.paused ? rawDt * this.engine.app.perf.timeScale * this.speed * Number(this.params.speed ?? 1) : 0;
    this.time += dt;
    this.stepAndDraw(dt);
    this.dirty = false;
    this.renderMs = performance.now() - t0;
    // Per-view budget: a view that is consistently slow is throttled on its own.
    if (this.renderMs > 22) {
      if (++this.slowCount > 30 && this.throttle < 4) { this.throttle *= 2; this.slowCount = 0; }
    } else if (this.renderMs < 8 && this.throttle > 1) {
      if (++this.slowCount > 120) { this.throttle /= 2; this.slowCount = 0; }
    } else this.slowCount = Math.max(0, this.slowCount - 1);
    this.fpsFrames++;
    if (now - this.fpsT >= 1000) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsT);
      this.fpsFrames = 0;
      this.fpsT = now;
    }
    this.events.emit('frame');
  }

  /** Advance the simulation by dt and draw one frame into the 2D canvas. */
  private stepAndDraw(dt: number): void {
    const renderer = this.engine.renderer!;
    const { w, h } = this.size;
    this.modulate();
    const input = this.input();
    const app = this.engine.app;
    this.rig.speed = Number(this.params.cameraSpeed ?? 1);
    this.rig.update(dt, app.get<number>('visualization.rotation_speed') * (app.perf.reducedMotion ? 0.4 : 1), this.inst?.track ? () => this.inst!.track!() : null);
    const cam = this.inst!.camera ?? this.rig.camera;
    for (const l of this.layers) {
      const p = l === this.layers[0] ? this.params : { ...l.params, layerOpacity: l.opacity };
      l.inst.update(dt, this.time, p, input, cam);
    }
    if (this.pointer.inside && this.inst!.hover) {
      this.ndc.set(this.pointer.x * 2 - 1, -(this.pointer.y * 2 - 1));
      this.inst!.hover(this.ndc, cam);
    } else this.inst!.hover?.(null, cam);
    this.engine.ensureCanvas(w, h);
    renderer.setClearColor(this.colors.background, 1);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    this.composer!.render(dt);
    this.g.drawImage(this.engine.canvas, 0, this.engine.bufferHeight - h, w, h, 0, 0, this.canvas.width, this.canvas.height);
    if (this.hud && app.get<boolean>('visualization.hud') && this.inst!.hud) {
      const g = this.g;
      g.save();
      const scale = this.canvas.width / Math.max(1, this.container.clientWidth);
      g.scale(scale, scale);
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      const v = new THREE.Vector3();
      const info: HudInfo = {
        fps: this.fps,
        camera: this.rig.mode,
        time: this.time,
        showFps: app.get<boolean>('performance.show_fps'),
        colors: this.colors.css,
        project: (p) => {
          v.copy(p).project(cam);
          return { x: (v.x * 0.5 + 0.5) * cw, y: (-v.y * 0.5 + 0.5) * ch, visible: v.z > -1 && v.z < 1 };
        },
      };
      try { this.inst!.hud(g, cw, ch, info); } catch (e) { console.error(e); }
      g.restore();
    } else if (app.get<boolean>('performance.show_fps')) {
      this.g.fillStyle = this.colors.css.dim;
      this.g.font = `${10 * (window.devicePixelRatio || 1)}px ${this.colors.css.mono}`;
      this.g.fillText(`${this.fps.toFixed(0)} FPS`, 8, this.canvas.height - 8);
    }
  }

  // ───────────────────────── capture ─────────────────────────

  async screenshotPng(): Promise<Uint8Array> {
    this.markDirty();
    this.render(performance.now());
    const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('could not encode PNG');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Deterministic offline rendering at a fixed resolution/frame rate (for
   * image sequences, GIF and MP4 export). Calls onFrame with each PNG/RGBA frame.
   */
  async renderOffline(opts: { width: number; height: number; fps: number; frames: number; format: 'png' | 'rgba' }, onFrame: (i: number, data: Uint8Array, w: number, h: number) => Promise<void>, shouldStop: () => boolean): Promise<number> {
    const prevSize = { ...this.size };
    const prevPlaying = this.playing;
    const w = Math.min(4096, opts.width || this.size.w);
    const hgt = Math.min(4096, opts.height || this.size.h);
    this.overrideSize = { w, h: hgt };
    this.size = { w: 0, h: 0 };
    this.resize();
    this.playing = false;
    const dt = (1 / opts.fps) * this.engine.app.perf.timeScale * this.speed;
    let done = 0;
    try {
      for (let i = 0; i < opts.frames && !shouldStop(); i++) {
        this.time += dt;
        this.stepAndDraw(dt);
        if (opts.format === 'png') {
          const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/png'));
          if (!blob) throw new Error('PNG encoding failed');
          await onFrame(i, new Uint8Array(await blob.arrayBuffer()), w, hgt);
        } else {
          const img = this.g.getImageData(0, 0, w, hgt);
          await onFrame(i, new Uint8Array(img.data.buffer), w, hgt);
        }
        done++;
      }
    } finally {
      this.overrideSize = null;
      this.size = prevSize;
      this.size = { w: 0, h: 0 };
      this.resize();
      this.playing = prevPlaying;
    }
    return done;
  }

  stats(): Record<string, string | number> {
    return { engine: this.def?.name ?? '—', preset: this.preset.name, size: `${this.size.w}×${this.size.h}`, fps: this.fps.toFixed(1), renderMs: this.renderMs.toFixed(2), throttle: this.throttle, ...(this.inst?.stats() ?? {}) };
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.engine.unregister(this);
    this.ro.disconnect();
    for (const r of this.releases) r();
    this.releases = [];
    this.teardown();
    this.rig.dispose();
    this.canvas.remove();
  }
}

/** Sample a keyframe track at time t (seconds). */
export function sampleTrack(keys: { t: number; v: number | string; ease: string }[], t: number): number | null {
  const nums = keys.filter((k) => typeof k.v === 'number') as { t: number; v: number; ease: string }[];
  if (!nums.length) return null;
  if (t <= nums[0].t) return nums[0].v;
  for (let i = 0; i < nums.length - 1; i++) {
    const a = nums[i], b = nums[i + 1];
    if (t >= a.t && t <= b.t) {
      let u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      switch (b.ease) {
        case 'step': u = 0; break;
        case 'smooth': u = u * u * (3 - 2 * u); break;
        case 'in': u = u * u; break;
        case 'out': u = 1 - (1 - u) * (1 - u); break;
      }
      return a.v + (b.v - a.v) * u;
    }
  }
  return nums[nums.length - 1].v;
}

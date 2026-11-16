/**
 * Workspace manager: mounts module instances into frames, lays them out in
 * grid / freeform / hybrid mode, keeps runtime state across workspace
 * switches, and persists changes to layouts/<id>.json.
 */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { debounce, h, type Emitter } from '../core/util';
import { Emitter as Em } from '../core/util';
import { moduleType, type DisposeReason, type ModuleContext, type SynModule } from './module';
import { clone, gridCellRect, isDocked, validateWorkspace, type ModuleInstance, type Rect, type Workspace } from '../../shared/workspace';
import { BUILTIN_WORKSPACES } from '../../shared/profiles';

interface Mounted {
  inst: ModuleInstance;
  frame: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  statusEl: HTMLElement;
  badgeEl: HTMLElement;
  module: SynModule | null;
  disposers: (() => void)[];
  rect: Rect;
  visible: boolean;
  error: string | null;
}

export class WorkspaceManager {
  current: Workspace | null = null;
  readonly events: Emitter<{ switched: [Workspace]; changed: [Workspace]; layout: [] }> = new Em();
  private mounted = new Map<string, Mounted>();
  private runtime = new Map<string, Map<string, Record<string, unknown>>>();
  private ro: ResizeObserver;
  private size = { w: 0, h: 0 };
  private saveSoon = debounce(() => void this.saveNow(), 600);
  private switching = false;

  constructor(private app: App, readonly root: HTMLElement) {
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(root);
    app.events.on('theme', (t) => {
      for (const m of this.mounted.values()) {
        this.applyModuleStyle(m);
        try { m.module?.onTheme(this.app.moduleTheme(m.inst.type, m.inst.style)); } catch (e) { console.error(e); }
      }
      void t;
    });
    app.events.on('config', (changed) => {
      if (changed.includes('interface.show_titles')) document.body.classList.toggle('no-titles', !app.get<boolean>('interface.show_titles'));
      for (const m of this.mounted.values()) {
        try { m.module?.onConfig(changed); } catch (e) { console.error(e); }
      }
      if (changed.includes('application.workspace') && app.get<string>('application.workspace') !== this.current?.id) void this.switchTo(app.get<string>('application.workspace'), false);
    });
    app.events.on('layouts', () => {
      // An external edit of the active layout file is applied live.
      const latest = app.layouts.find((l) => l.id === this.current?.id);
      if (latest && this.current && JSON.stringify(latest) !== JSON.stringify(this.current) && !this.app.overlays?.editorOpen) this.apply(latest, { save: false });
    });
    window.addEventListener('beforeunload', () => {
      this.saveSoon.flush();
      for (const m of this.mounted.values()) this.disposeMounted(m, 'reload');
    });
  }

  // ───────────────────────── profiles ─────────────────────────

  list(): Workspace[] {
    return this.app.layouts;
  }

  find(id: string): Workspace | undefined {
    return this.app.layouts.find((w) => w.id === id) ?? BUILTIN_WORKSPACES.find((w) => w.id === id);
  }

  async switchTo(id: string, persist = true): Promise<boolean> {
    const ws = this.find(id);
    if (!ws) {
      this.app.overlays?.toast(`Unknown workspace "${id}"`, 'error');
      return false;
    }
    if (this.switching) return false;
    this.switching = true;
    try {
      this.saveSoon.flush();
      if (this.current) {
        const state = new Map<string, Record<string, unknown>>();
        for (const [mid, m] of this.mounted) {
          const s = m.module?.serialize();
          if (s) state.set(mid, s);
        }
        this.runtime.set(this.current.id, state);
        for (const m of this.mounted.values()) this.disposeMounted(m, 'switch');
        this.mounted.clear();
      }
      this.current = clone(ws);
      this.app.applyTheme();
      this.app.perf?.events.emit('change');
      this.mountAll();
      this.layout();
      if (persist && this.app.get<string>('application.workspace') !== id) await this.app.set({ 'application.workspace': id });
      this.app.sounds?.play('panels');
      this.events.emit('switched', this.current);
      return true;
    } finally {
      this.switching = false;
    }
  }

  cycle(dir: 1 | -1): void {
    const all = this.list();
    const i = all.findIndex((w) => w.id === this.current?.id);
    const next = all[(i + dir + all.length) % all.length];
    if (next) void this.switchTo(next.id);
  }

  async saveNow(asNew?: { id: string; name: string }): Promise<boolean> {
    if (!this.current) return false;
    const ws = asNew ? { ...clone(this.current), id: asNew.id, name: asNew.name } : this.current;
    const r = await bridge.config.saveLayout(ws);
    if (!r.ok) {
      this.app.overlays?.toast(`Could not save workspace: ${r.error}`, 'error');
      return false;
    }
    if (asNew) {
      await this.app.reloadLayouts();
      await this.switchTo(asNew.id);
    }
    return true;
  }

  async resetToDefault(): Promise<void> {
    if (!this.current) return;
    const builtin = BUILTIN_WORKSPACES.find((w) => w.id === this.current!.id);
    if (!builtin) return;
    await bridge.config.deleteLayout(this.current.id);
    await this.app.reloadLayouts();
    this.apply(clone(builtin), { save: false });
  }

  // ───────────────────────── applying changes ─────────────────────────

  /** Replace the current workspace definition, reconciling mounted modules. */
  apply(next: Workspace, opts: { save?: boolean } = {}): void {
    const v = validateWorkspace(next);
    if (!v.ok) {
      this.app.overlays?.toast(`Invalid workspace: ${v.error}`, 'error');
      return;
    }
    const prev = this.current;
    this.current = v.ws;
    const nextIds = new Set(v.ws.modules.map((m) => m.id));
    for (const [id, m] of this.mounted) {
      if (!nextIds.has(id)) {
        this.disposeMounted(m, 'remove');
        this.mounted.delete(id);
      }
    }
    for (const inst of v.ws.modules) {
      const m = this.mounted.get(inst.id);
      if (!m) {
        this.mountModule(inst);
        continue;
      }
      const before = m.inst;
      m.inst = inst;
      if (JSON.stringify(before.config) !== JSON.stringify(inst.config)) {
        const keys = new Set([...Object.keys(before.config), ...Object.keys(inst.config)]);
        const changed = [...keys].filter((k) => JSON.stringify(before.config[k]) !== JSON.stringify(inst.config[k]));
        try { m.module?.update(changed); } catch (e) { console.error(e); }
      }
      if (before.title !== inst.title) m.titleEl.textContent = this.titleOf(inst);
      if (JSON.stringify(before.style) !== JSON.stringify(inst.style)) {
        this.applyModuleStyle(m);
        try { m.module?.onTheme(this.app.moduleTheme(inst.type, inst.style)); } catch (e) { console.error(e); }
      }
    }
    if (prev && (prev.theme !== v.ws.theme || JSON.stringify(prev.themeOverride) !== JSON.stringify(v.ws.themeOverride))) this.app.applyTheme();
    if (prev && prev.performance !== v.ws.performance) this.app.perf?.events.emit('change');
    this.layout();
    this.events.emit('changed', v.ws);
    if (opts.save !== false) this.saveSoon();
  }

  patchModuleConfig(id: string, patch: Record<string, unknown>, save = true): void {
    if (!this.current) return;
    const next = clone(this.current);
    const inst = next.modules.find((m) => m.id === id);
    if (!inst) return;
    inst.config = { ...inst.config, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete inst.config[k];
    this.apply(next, { save });
  }

  // ───────────────────────── mounting ─────────────────────────

  private mountAll(): void {
    this.root.replaceChildren();
    if (!this.current) return;
    for (const inst of this.current.modules) this.mountModule(inst);
  }

  private titleOf(inst: ModuleInstance): string {
    return inst.title || moduleType(inst.type)?.manifest.name || inst.type;
  }

  private mountModule(inst: ModuleInstance): void {
    const type = moduleType(inst.type);
    const titleEl = h('span.t', this.titleOf(inst));
    const statusEl = h('span.s');
    const badgeEl = h('span.badge');
    badgeEl.hidden = true;
    const head = h('header.mod-title', h('span.row', titleEl, badgeEl), statusEl);
    const body = h('div.mod-body');
    const frame = h('section.mod.entering', { 'data-id': inst.id, 'data-type': inst.type, tabindex: '-1' }, head, body);
    frame.addEventListener('animationend', () => frame.classList.remove('entering'), { once: true });
    frame.addEventListener('pointerdown', () => this.focusModule(inst.id), true);
    this.root.append(frame);
    const m: Mounted = { inst, frame, body, titleEl, statusEl, badgeEl, module: null, disposers: [], rect: { x: 0, y: 0, w: 0, h: 0 }, visible: true, error: null };
    this.mounted.set(inst.id, m);
    this.applyModuleStyle(m);
    if (!type) {
      m.error = `Module type "${inst.type}" is not installed or not enabled.`;
      body.append(h('div.na', m.error));
      return;
    }
    const schema = type.manifest.configSchema;
    const ctx: ModuleContext = {
      app: this.app,
      id: inst.id,
      type: inst.type,
      frame,
      body,
      instance: () => m.inst,
      config: <T,>(key: string, fallback?: T): T => {
        const v = m.inst.config[key];
        if (v !== undefined) return v as T;
        const def = schema.find((s) => s.key === key);
        return (def ? def.default : fallback) as T;
      },
      updateConfig: (patch) => this.patchModuleConfig(inst.id, patch),
      setTitle: (t) => { titleEl.textContent = m.inst.title || t; },
      setStatus: (t) => { if (statusEl.textContent !== t) statusEl.textContent = t; },
      setBadge: (kind, text) => {
        badgeEl.hidden = !kind;
        badgeEl.className = `badge ${kind ?? ''}`;
        badgeEl.textContent = text ?? (kind === 'live' ? 'LIVE' : kind === 'sim' ? 'SIMULATED' : kind === 'off' ? 'OFF' : '');
      },
      theme: () => this.app.moduleTheme(inst.type, m.inst.style),
      visible: () => m.visible,
      focus: () => this.focusModule(inst.id),
      onDispose: (fn) => m.disposers.push(fn),
    };
    try {
      m.module = type.create(ctx);
      const state = this.runtime.get(this.current!.id)?.get(inst.id);
      const r = m.module.mount();
      const after = () => {
        if (state) {
          try { m.module?.restore(state); } catch (e) { console.error(e); }
          this.runtime.get(this.current!.id)?.delete(inst.id);
        }
      };
      if (r instanceof Promise) r.then(after).catch((e) => this.moduleFailed(m, e));
      else after();
    } catch (e) {
      this.moduleFailed(m, e);
    }
  }

  private moduleFailed(m: Mounted, e: unknown): void {
    console.error(e);
    m.error = (e as Error)?.message ?? String(e);
    m.body.replaceChildren(h('div.na', `Module failed to start: ${m.error}`));
    void bridge.app.log('error', `module ${m.inst.type}/${m.inst.id} failed: ${m.error}`);
  }

  private disposeMounted(m: Mounted, reason: DisposeReason): void {
    try { m.module?.dispose(reason); } catch (e) { console.error(e); }
    for (const d of m.disposers) {
      try { d(); } catch (e) { console.error(e); }
    }
    m.disposers = [];
    m.module = null;
    m.frame.remove();
  }

  private applyModuleStyle(m: Mounted): void {
    const t = this.app.moduleTheme(m.inst.type, m.inst.style);
    const base = this.app.activeTheme;
    const frame = m.frame;
    // Only emit per-module variables that differ from the global theme.
    const vars: [string, string, string][] = [
      ['--bg', t.colors.background, base?.colors.background], ['--surface', t.colors.surface, base?.colors.surface], ['--fg', t.colors.foreground, base?.colors.foreground],
      ['--text', t.colors.text, base?.colors.text], ['--text-dim', t.colors.text_dim, base?.colors.text_dim], ['--border', t.colors.border, base?.colors.border],
      ['--accent', t.colors.accent, base?.colors.accent], ['--glow', t.colors.glow, base?.colors.glow], ['--highlight', t.colors.highlight, base?.colors.highlight],
      ['--border-w', `${t.effects.border_width}px`, `${base?.effects.border_width}px`], ['--border-a', String(t.effects.border_alpha), String(base?.effects.border_alpha)],
      ['--glow-i', String(t.effects.glow_intensity), String(base?.effects.glow_intensity)], ['--shadow-i', String(t.effects.shadow_intensity), String(base?.effects.shadow_intensity)],
      ['--panel-a', String(t.effects.panel_alpha), String(base?.effects.panel_alpha)], ['--font-size', `${t.typography.font_size}px`, `${base?.typography.font_size}px`],
      ['--font-ui', `"${t.typography.ui_font}", "United Sans Medium", sans-serif`, `"${base?.typography.ui_font}", "United Sans Medium", sans-serif`],
      ['--font-mono', `"${t.typography.mono_font}", "Fira Mono", monospace`, `"${base?.typography.mono_font}", "Fira Mono", monospace`],
      ['--pad', `${t.spacing.panel_padding}px`, `${base?.spacing.panel_padding}px`], ['--radius', `${t.spacing.radius}px`, `${base?.spacing.radius}px`],
      ['--neural', t.colors.neural, base?.colors.neural], ['--particle', t.colors.particle, base?.colors.particle],
    ];
    for (const [k, v, b2] of vars) {
      if (v !== b2) frame.style.setProperty(k, v);
      else frame.style.removeProperty(k);
    }
    t.colors.graph.forEach((g, i) => (g !== base?.colors.graph[i] ? frame.style.setProperty(`--graph-${i}`, g) : frame.style.removeProperty(`--graph-${i}`)));
    frame.classList.toggle('chromeless', m.inst.config.chrome === false);
    frame.classList.toggle('hidden-mod', !!m.inst.hidden);
  }

  // ───────────────────────── layout ─────────────────────────

  layout(): void {
    const ws = this.current;
    if (!ws) return;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    this.size = { w: W, h: H };
    for (const m of this.mounted.values()) {
      const l = m.inst.layout;
      const docked = isDocked(ws, m.inst);
      const r = docked ? gridCellRect(ws.grid, l, W, H) : { x: l.x * W, y: l.y * H, w: l.w * W, h: l.h * H };
      m.rect = r;
      const s = m.frame.style;
      s.left = `${Math.round(r.x)}px`;
      s.top = `${Math.round(r.y)}px`;
      s.width = `${Math.max(20, Math.round(r.w))}px`;
      s.height = `${Math.max(20, Math.round(r.h))}px`;
      s.zIndex = String(this.effectiveZ(ws, m.inst));
      s.opacity = String(l.opacity);
      s.transform = !docked && l.rotation ? `rotate(${l.rotation}deg)` : '';
      m.frame.classList.toggle('floating', !docked);
    }
    this.computeVisibility();
    for (const m of this.mounted.values()) {
      try { m.module?.resize(m.rect.w, m.rect.h); } catch (e) { console.error(e); }
    }
    this.events.emit('layout');
  }

  effectiveZ(ws: Workspace, inst: ModuleInstance): number {
    const docked = isDocked(ws, inst);
    return (docked ? 0 : 1000) + (inst.layout.pinned ? 5000 : 0) + inst.layout.z;
  }

  /** Mark modules hidden, transparent or fully covered by an opaque module above as not visible. */
  private computeVisibility(): void {
    const ws = this.current!;
    const list = [...this.mounted.values()];
    for (const m of list) {
      let vis = !m.inst.hidden && m.inst.layout.opacity > 0.05 && m.rect.w > 4 && m.rect.h > 4;
      if (vis) {
        const z = this.effectiveZ(ws, m.inst);
        for (const o of list) {
          if (o === m || o.inst.hidden || o.inst.layout.opacity < 0.98 || o.inst.config.chrome === false) continue;
          if (this.effectiveZ(ws, o.inst) <= z) continue;
          if (o.rect.x <= m.rect.x && o.rect.y <= m.rect.y && o.rect.x + o.rect.w >= m.rect.x + m.rect.w && o.rect.y + o.rect.h >= m.rect.y + m.rect.h && !o.inst.layout.rotation) {
            vis = false;
            break;
          }
        }
      }
      if (vis !== m.visible) {
        m.visible = vis;
        try { if (vis) m.module?.resume(); else m.module?.pause(); } catch (e) { console.error(e); }
      }
    }
  }

  // ───────────────────────── queries ─────────────────────────

  get workspaceSize(): { w: number; h: number } {
    return this.size;
  }

  moduleRects(): { id: string; rect: Rect; inst: ModuleInstance }[] {
    return [...this.mounted.values()].map((m) => ({ id: m.inst.id, rect: m.rect, inst: m.inst }));
  }

  frameOf(id: string): HTMLElement | null {
    return this.mounted.get(id)?.frame ?? null;
  }

  moduleOf<T extends SynModule = SynModule>(id: string): T | null {
    return (this.mounted.get(id)?.module as T) ?? null;
  }

  modulesOfType<T extends SynModule = SynModule>(type: string): { id: string; module: T }[] {
    return [...this.mounted.values()].filter((m) => m.inst.type === type && m.module).map((m) => ({ id: m.inst.id, module: m.module as T }));
  }

  focusModule(id: string | null): void {
    if (this.app.focusedModule === id) return;
    if (this.app.focusedModule) this.mounted.get(this.app.focusedModule)?.frame.classList.remove('focused');
    this.app.focusedModule = id;
    if (id) {
      const m = this.mounted.get(id);
      m?.frame.classList.add('focused');
      try { m?.module?.focus(); } catch (e) { console.error(e); }
    }
    this.app.events.emit('focus', id);
  }

  /** Focused module of a type, or the first one of that type. */
  preferred<T extends SynModule = SynModule>(type: string): { id: string; module: T } | null {
    const f = this.app.focusedModule ? this.mounted.get(this.app.focusedModule) : null;
    if (f && f.inst.type === type && f.module) return { id: f.inst.id, module: f.module as T };
    const all = this.modulesOfType<T>(type).filter((x) => this.mounted.get(x.id)?.visible);
    return all[0] ?? this.modulesOfType<T>(type)[0] ?? null;
  }

  shutdown(): void {
    this.saveSoon.flush();
    for (const m of this.mounted.values()) this.disposeMounted(m, 'shutdown');
    this.mounted.clear();
  }
}

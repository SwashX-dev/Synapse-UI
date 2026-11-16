/**
 * Renderer application state: configuration snapshot, themes, layouts,
 * presets and keybindings, plus a typed event bus. Services (graphics,
 * workspace, monitoring, audio …) are attached during bootstrap.
 */
import { bridge, type ConfigSnapshot } from './bridge';
import { Emitter } from './util';
import type { AppInfo } from '../../shared/ipc';
import type { Config, ConfigIssue, SettingValue } from '../../shared/settings';
import { applyOverride, BUILTIN_THEMES, convertLegacyEdexTheme, themeCssVars, type Theme, type ThemeOverride } from '../../shared/theme';
import type { Workspace } from '../../shared/workspace';
import type { Preset } from '../../shared/manifest';
import type { MonitorStore } from './monitor';
import type { DataSources } from './datasources';
import type { AudioEngine } from './audio';
import type { Sounds } from './sounds';
import type { PerformanceManager } from './perf';
import type { GraphicsEngine } from '../graphics/engine';
import type { WorkspaceManager } from '../workspace/manager';
import type { CommandRegistry } from './commands';
import type { Keybindings } from './keys';
import type { Overlays } from '../ui/overlays';
import type { ExtensionInfo } from './bridge';
import { BUILTIN_PRESETS } from '../graphics/presets';

// Original eDEX-UI themes, bundled and converted at startup.
import edexApollo from '../../assets/themes/apollo.json';
import edexBlade from '../../assets/themes/blade.json';
import edexChalkboard from '../../assets/themes/chalkboard.json';
import edexCyborg from '../../assets/themes/cyborg.json';
import edexInterstellar from '../../assets/themes/interstellar.json';
import edexMatrix from '../../assets/themes/matrix.json';
import edexNavy from '../../assets/themes/navy.json';
import edexNord from '../../assets/themes/nord.json';
import edexRed from '../../assets/themes/red.json';
import edexTron from '../../assets/themes/tron.json';

const LEGACY_THEMES: [string, unknown][] = [
  ['tron', edexTron], ['blade', edexBlade], ['apollo', edexApollo], ['chalkboard', edexChalkboard], ['cyborg', edexCyborg],
  ['interstellar', edexInterstellar], ['matrix', edexMatrix], ['navy', edexNavy], ['nord', edexNord], ['red', edexRed],
];

export interface AppEvents extends Record<string, unknown[]> {
  config: [changed: string[], source: 'gui' | 'file' | 'init'];
  issues: [issues: ConfigIssue[]];
  theme: [theme: Theme];
  themes: [];
  layouts: [];
  presets: [];
  bindings: [];
  extensions: [];
  focus: [moduleId: string | null];
}

export class App {
  readonly events = new Emitter<AppEvents>();
  info!: AppInfo;
  snapshot!: ConfigSnapshot;
  themes: Theme[] = [];
  userThemes: string[] = [];
  layouts: Workspace[] = [];
  builtinLayouts: string[] = [];
  userLayouts: string[] = [];
  userPresets: Preset[] = [];
  extensionInfo: ExtensionInfo[] = [];
  extensionPresets: Preset[] = [];
  assetErrors: { file: string; error: string }[] = [];
  activeTheme!: Theme;
  focusedModule: string | null = null;

  // services (attached by main.ts)
  monitor!: MonitorStore;
  data!: DataSources;
  audio!: AudioEngine;
  sounds!: Sounds;
  perf!: PerformanceManager;
  graphics!: GraphicsEngine;
  workspace!: WorkspaceManager;
  commands!: CommandRegistry;
  keys!: Keybindings;
  overlays!: Overlays;

  private legacyThemes: Theme[] = [];

  async init(): Promise<void> {
    this.info = await bridge.app.info();
    this.snapshot = await bridge.config.get();
    this.legacyThemes = LEGACY_THEMES.map(([id, raw]) => {
      try { return convertLegacyEdexTheme(`edex-${id}`, `eDEX: ${id}`, raw); } catch { return null; }
    }).filter((t): t is Theme => !!t);
    await Promise.all([this.reloadThemes(), this.reloadLayouts(), this.reloadPresets(), this.reloadExtensions()]);
    bridge.config.onChange((ev) => {
      this.snapshot = ev.snapshot;
      const assets = ev.changed.filter((c) => c.startsWith('assets:'));
      const settings = ev.changed.filter((c) => !c.startsWith('assets:') && c !== 'keybindings');
      if (ev.changed.includes('keybindings')) this.events.emit('bindings');
      for (const a of assets) {
        if (a === 'assets:themes') void this.reloadThemes();
        if (a === 'assets:layouts') void this.reloadLayouts();
        if (a === 'assets:presets') void this.reloadPresets();
        if (a === 'assets:modules') void this.reloadExtensions();
      }
      if (settings.length) {
        this.events.emit('config', settings, ev.source);
        if (settings.some((k) => k === 'application.theme' || k.startsWith('colors.'))) this.applyTheme();
      }
      if (ev.snapshot.issues.length) this.events.emit('issues', ev.snapshot.issues);
    });
    bridge.config.onIssues((issues) => {
      this.snapshot = { ...this.snapshot, issues };
      this.events.emit('issues', issues);
    });
  }

  get config(): Config {
    return this.snapshot.config;
  }

  get<T extends SettingValue = SettingValue>(key: string): T {
    return this.snapshot.config[key] as T;
  }

  async set(patch: Record<string, unknown>): Promise<boolean> {
    const r = await bridge.config.set(patch);
    if (!r.ok) {
      this.overlays?.toast(`Setting rejected: ${r.issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`, 'error');
      return false;
    }
    // main broadcasts the change; also apply optimistically for responsiveness.
    for (const [k, v] of Object.entries(patch)) if (v !== null) this.snapshot.config[k] = v as SettingValue;
    return true;
  }

  // ───────────────────────── assets ─────────────────────────

  async reloadThemes(): Promise<void> {
    const r = await bridge.config.themes();
    const ids = new Set(r.themes.map((t) => t.id));
    this.themes = [...r.themes, ...this.legacyThemes.filter((t) => !ids.has(t.id))];
    this.userThemes = r.user;
    this.assetErrors = [...this.assetErrors.filter((e) => !e.file.endsWith('.toml')), ...r.errors];
    this.events.emit('themes');
    if (this.activeTheme) this.applyTheme();
  }

  async reloadLayouts(): Promise<void> {
    const r = await bridge.config.layouts();
    this.layouts = r.layouts;
    this.builtinLayouts = r.builtin;
    this.userLayouts = r.user;
    this.assetErrors = [...this.assetErrors.filter((e) => !e.file.endsWith('.json')), ...r.errors];
    this.events.emit('layouts');
  }

  async reloadPresets(): Promise<void> {
    const r = await bridge.config.presets();
    this.userPresets = r.presets;
    this.events.emit('presets');
  }

  async reloadExtensions(): Promise<void> {
    try {
      this.extensionInfo = await bridge.ext.list();
    } catch {
      this.extensionInfo = [];
    }
    this.extensionPresets = this.extensionInfo.filter((e) => e.enabled && e.manifest?.kind === 'presets').flatMap((e) => (e.manifest!.presets ?? []).map((p) => ({ ...p, id: p.id, category: 'custom' as const })));
    this.events.emit('extensions');
    this.events.emit('presets');
  }

  presets(): Preset[] {
    const byId = new Map<string, Preset>();
    for (const p of BUILTIN_PRESETS) byId.set(p.id, p);
    for (const p of this.extensionPresets) if (!byId.has(p.id)) byId.set(p.id, p);
    for (const p of this.userPresets) byId.set(p.id, p);
    return [...byId.values()];
  }

  preset(id: string): Preset | undefined {
    return this.presets().find((p) => p.id === id);
  }

  theme(id: string): Theme | undefined {
    return this.themes.find((t) => t.id === id);
  }

  // ───────────────────────── theme application ─────────────────────────

  /** Theme for the current workspace: workspace theme → global theme, then global [colors] overrides, then workspace overrides. */
  resolveTheme(ws?: Workspace | null): Theme {
    const id = ws?.theme || this.get<string>('application.theme');
    let t = this.theme(id) ?? this.theme(this.get<string>('application.theme')) ?? BUILTIN_THEMES[0];
    const colorKeys = ['background', 'foreground', 'text', 'accent', 'border', 'glow', 'highlight', 'neural', 'particle'] as const;
    const colorOverride: Record<string, string> = {};
    for (const k of colorKeys) {
      const v = this.get<string>(`colors.${k}`);
      if (v) colorOverride[k === 'neural' ? 'neural' : k] = v;
    }
    if (Object.keys(colorOverride).length) t = applyOverride(t, { colors: colorOverride });
    if (ws?.themeOverride) t = applyOverride(t, ws.themeOverride);
    return t;
  }

  /** Theme for one module: resolved theme + per-module-type tokens + per-instance style. */
  moduleTheme(type: string, style?: ThemeOverride): Theme {
    let t = this.activeTheme;
    const typeOverride = t.modules?.[type];
    if (typeOverride) t = applyOverride(t, typeOverride);
    if (style) t = applyOverride(t, style);
    return t;
  }

  applyTheme(previewTheme?: Theme): void {
    const t = previewTheme ?? this.resolveTheme(this.workspace?.current);
    this.activeTheme = t;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeCssVars(t))) root.style.setProperty(k, v);
    root.style.setProperty('--panel-transparency', String(this.get<number>('interface.panel_transparency')));
    const body = document.body;
    body.classList.toggle('grid-pattern', t.effects.grid_pattern);
    body.classList.toggle('scanlines', t.effects.scanlines > 0);
    body.classList.toggle('smoothing-subpixel', t.typography.font_smoothing === 'subpixel');
    body.classList.toggle('smoothing-none', t.typography.font_smoothing === 'none');
    this.events.emit('theme', t);
  }
}

export const app = new App();

/**
 * Configuration service: owns every file under the config directory.
 *
 *  - config.toml        validated settings (per-field fallback, never crashes startup)
 *  - keybindings.toml   action → accelerator
 *  - themes/*.toml      user themes (same id overrides a built-in)
 *  - layouts/*.json     workspace profiles (same id overrides a built-in)
 *  - animations/presets/*.json
 *  - backups/           automatic timestamped copies
 *
 * GUI changes are written atomically and immediately. External edits are
 * detected with fs.watch, validated, backed up and applied live. If an
 * external edit has a syntax error the previous settings stay active.
 *
 * Deliberately free of Electron imports so it can be unit-tested in Node.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';
import { CONFIG_VERSION, applyPatch, defaultConfig, diffConfig, emitConfigToml, nestConfig, validateConfig, type Config, type ConfigIssue } from '../shared/settings';
import { BUILTIN_THEMES, CUSTOM_THEME, ThemeFileSchema, ThemeSchema, materializeTheme, themeToFile, type Theme } from '../shared/theme';
import { BUILTIN_WORKSPACES } from '../shared/profiles';
import { validateWorkspace, type Workspace } from '../shared/workspace';
import { PresetSchema, type Preset } from '../shared/manifest';
import { ACTIONS, validateBindings } from '../shared/keybindings';
import { emitTomlDocument, tomlComment, tomlString } from '../shared/toml';
import type { AppPaths } from './paths';
import { logger } from './log';

const log = logger('config');

export interface ConfigSnapshot {
  config: Config;
  issues: ConfigIssue[];
  bindings: Record<string, string>;
  bindingIssues: string[];
  paths: AppPaths;
  firstRun: boolean;
}

export interface ThemeListing { themes: Theme[]; builtin: string[]; user: string[]; errors: { file: string; error: string }[] }
export interface LayoutListing { layouts: Workspace[]; builtin: string[]; user: string[]; errors: { file: string; error: string }[] }
export interface PresetListing { presets: Preset[]; errors: { file: string; error: string }[] }

export interface ExportBundle {
  format: 'synapse-ui-export';
  version: number;
  exported: string;
  config: Record<string, unknown>;
  keybindings: Record<string, string>;
  themes: Record<string, unknown>[];
  layouts: Workspace[];
  presets: Preset[];
}

export class ConfigService extends EventEmitter {
  config: Config = defaultConfig();
  issues: ConfigIssue[] = [];
  bindings: Record<string, string> = {};
  bindingIssues: string[] = [];
  firstRun = false;
  legacyImported: string | null = null;
  private lastWritten = new Map<string, string>();
  private watchers: fs.FSWatcher[] = [];
  private debounce = new Map<string, NodeJS.Timeout>();

  constructor(readonly paths: AppPaths, private readonly legacySettingsPath?: string) {
    super();
  }

  /** Synchronous so it can run before Electron is ready (Chromium flags depend on it). */
  init(): void {
    for (const dir of [this.paths.config, this.paths.themes, this.paths.layouts, this.paths.modules, this.paths.presets, this.paths.backups]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.paths.configFile)) {
      this.firstRun = true;
      const cfg = defaultConfig();
      const imported = this.legacySettingsPath ? importLegacyEdexSettings(this.legacySettingsPath) : null;
      if (imported) {
        const r = applyPatch(cfg, imported.patch);
        if (r.ok) Object.assign(cfg, r.config);
        this.legacyImported = this.legacySettingsPath!;
        log.info(`Imported ${Object.keys(imported.patch).length} settings from legacy eDEX-UI config ${this.legacySettingsPath}`);
      }
      this.config = cfg;
      this.writeFile(this.paths.configFile, emitConfigToml(cfg));
    } else {
      this.loadConfigFile(false);
    }
    if (!fs.existsSync(this.paths.keybindingsFile)) this.writeKeybindings(validateBindings({}).bindings);
    else this.loadKeybindings(false);
    const customFile = path.join(this.paths.themes, 'custom.toml');
    if (!fs.existsSync(customFile)) this.writeFile(customFile, themeToToml(CUSTOM_THEME));
    const readme = path.join(this.paths.config, 'README.txt');
    if (!fs.existsSync(readme)) this.writeFile(readme, README_TEXT);
  }

  snapshot(): ConfigSnapshot {
    return { config: { ...this.config }, issues: [...this.issues], bindings: { ...this.bindings }, bindingIssues: [...this.bindingIssues], paths: this.paths, firstRun: this.firstRun };
  }

  get<T = unknown>(key: string): T {
    return this.config[key] as T;
  }

  // ───────────────────────── settings ─────────────────────────

  set(patch: Record<string, unknown>): { ok: true; changed: string[] } | { ok: false; issues: ConfigIssue[] } {
    const r = applyPatch(this.config, patch);
    if (!r.ok) return r;
    const changed = diffConfig(this.config, r.config);
    if (changed.length === 0) return { ok: true, changed };
    this.config = r.config;
    this.issues = this.issues.filter((i) => !changed.includes(i.key));
    this.writeFile(this.paths.configFile, emitConfigToml(this.config));
    this.emit('changed', { changed, source: 'gui' as const });
    return { ok: true, changed };
  }

  reset(keys: string[] | null): string[] {
    const defaults = defaultConfig();
    if (keys === null) this.backup('config-before-reset');
    const patch: Record<string, unknown> = {};
    for (const k of keys ?? Object.keys(defaults)) if (k in defaults) patch[k] = defaults[k];
    if (keys === null) patch['application.first_run_complete'] = true;
    const r = this.set(patch);
    return r.ok ? r.changed : [];
  }

  private loadConfigFile(emit: boolean): void {
    let text: string;
    try {
      text = fs.readFileSync(this.paths.configFile, 'utf8');
    } catch (e) {
      this.issues = [{ key: '', message: `cannot read config.toml: ${(e as Error).message}`, severity: 'error' }];
      return;
    }
    let raw: Record<string, unknown>;
    try {
      raw = parseToml(text) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof TomlError ? `syntax error at line ${e.line}, column ${e.column}: ${e.message.split('\n')[0]}` : String(e);
      this.issues = [{ key: '', message: `config.toml: ${msg} — keeping previous settings`, severity: 'error' }];
      log.warn(`config.toml parse failed: ${msg}`);
      if (emit) this.emit('issues', this.issues);
      return;
    }
    const version = typeof raw.config_version === 'number' ? raw.config_version : CONFIG_VERSION;
    if (version > CONFIG_VERSION) {
      this.backup('config-newer-version');
      this.issues = [{ key: 'config_version', message: `config.toml was written by a newer SYNAPSE-UI (format ${version}); unknown settings are ignored and a backup was saved`, severity: 'warning' }];
    }
    const migrated = migrateConfig(raw, version);
    const { config, issues } = validateConfig(migrated.raw);
    if (migrated.notes.length) {
      this.backup('config-before-migration');
      for (const note of migrated.notes) issues.push({ key: 'config_version', message: note, severity: 'warning' });
    }
    const changed = diffConfig(this.config, config);
    this.config = config;
    this.issues = [...(version > CONFIG_VERSION ? this.issues : []), ...issues];
    if (migrated.notes.length) this.writeFile(this.paths.configFile, emitConfigToml(config));
    if (emit) {
      if (changed.length) this.emit('changed', { changed, source: 'file' as const });
      this.emit('issues', this.issues);
    }
  }

  // ───────────────────────── keybindings ─────────────────────────

  private loadKeybindings(emit: boolean): void {
    try {
      const raw = parseToml(fs.readFileSync(this.paths.keybindingsFile, 'utf8')) as { bindings?: unknown };
      const r = validateBindings(raw.bindings ?? {});
      this.bindings = r.bindings;
      this.bindingIssues = r.issues;
    } catch (e) {
      this.bindingIssues = [`keybindings.toml: ${(e as Error).message.split('\n')[0]} — keeping previous bindings`];
      if (!Object.keys(this.bindings).length) this.bindings = validateBindings({}).bindings;
    }
    if (emit) this.emit('changed', { changed: ['keybindings'], source: 'file' as const });
  }

  saveKeybindings(raw: Record<string, string>): { ok: boolean; issues: string[] } {
    const r = validateBindings(raw);
    const hardErrors = r.issues.filter((i) => !i.includes('is bound to both'));
    if (hardErrors.length) return { ok: false, issues: hardErrors };
    this.bindings = r.bindings;
    this.bindingIssues = r.issues;
    this.writeKeybindings(r.bindings);
    this.emit('changed', { changed: ['keybindings'], source: 'gui' as const });
    return { ok: true, issues: r.issues };
  }

  private writeKeybindings(bindings: Record<string, string>): void {
    this.bindings = bindings;
    const lines = ['# SYNAPSE-UI keybindings', '# Format: "action.id" = "Ctrl+Shift+Key". Use "" to disable an action.', '# Modifiers: Ctrl, Alt, Shift, Meta. Edits apply live.', '', '[bindings]'];
    let cat = '';
    for (const a of ACTIONS) {
      if (a.category !== cat) { cat = a.category; lines.push('', `# ── ${cat} ──`); }
      lines.push(`${tomlString(a.id)} = ${tomlString(bindings[a.id] ?? '')}  # ${a.label}`);
    }
    this.writeFile(this.paths.keybindingsFile, lines.join('\n') + '\n');
  }

  // ───────────────────────── themes ─────────────────────────

  listThemes(): ThemeListing {
    const byId = new Map(BUILTIN_THEMES.map((t) => [t.id, t] as const));
    const files: { id: string; file: string; data: unknown }[] = [];
    const errors: ThemeListing['errors'] = [];
    for (const name of safeReaddir(this.paths.themes)) {
      if (!name.endsWith('.toml')) continue;
      const file = path.join(this.paths.themes, name);
      try {
        files.push({ id: name.slice(0, -5), file: name, data: parseToml(fs.readFileSync(file, 'utf8')) });
      } catch (e) {
        errors.push({ file: name, error: (e as Error).message.split('\n')[0] });
      }
    }
    const user: string[] = [];
    // Two passes so user themes may use other user themes as their base.
    for (let pass = 0; pass < 2; pass++) {
      for (const f of files) {
        const parsed = ThemeFileSchema.safeParse(f.data);
        if (!parsed.success) {
          if (pass === 1) errors.push({ file: f.file, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 4).join('; ') });
          continue;
        }
        if (parsed.data.base && !byId.has(parsed.data.base) && pass === 0) continue;
        try {
          byId.set(parsed.data.id, materializeTheme(parsed.data, (id) => byId.get(id)));
          if (!user.includes(parsed.data.id)) user.push(parsed.data.id);
        } catch (e) {
          if (pass === 1) errors.push({ file: f.file, error: (e as Error).message.slice(0, 300) });
        }
      }
    }
    return { themes: [...byId.values()], builtin: BUILTIN_THEMES.map((t) => t.id), user, errors };
  }

  saveTheme(raw: unknown): { ok: true; theme: Theme } | { ok: false; error: string } {
    const r = ThemeSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ') };
    this.writeFile(path.join(this.paths.themes, `${r.data.id}.toml`), themeToToml(r.data));
    this.emit('assets', 'themes');
    return { ok: true, theme: r.data };
  }

  deleteTheme(id: string): boolean {
    const file = path.join(this.paths.themes, `${id}.toml`);
    if (!fs.existsSync(file)) return false;
    this.backupFile(file, `theme-${id}`);
    fs.rmSync(file);
    this.emit('assets', 'themes');
    return true;
  }

  // ───────────────────────── layouts ─────────────────────────

  listLayouts(): LayoutListing {
    const byId = new Map(BUILTIN_WORKSPACES.map((w) => [w.id, w] as const));
    const user: string[] = [];
    const errors: LayoutListing['errors'] = [];
    for (const name of safeReaddir(this.paths.layouts)) {
      if (!name.endsWith('.json')) continue;
      try {
        const r = validateWorkspace(JSON.parse(fs.readFileSync(path.join(this.paths.layouts, name), 'utf8')));
        if (!r.ok) { errors.push({ file: name, error: r.error }); continue; }
        byId.set(r.ws.id, r.ws);
        user.push(r.ws.id);
      } catch (e) {
        errors.push({ file: name, error: (e as Error).message.split('\n')[0] });
      }
    }
    return { layouts: [...byId.values()], builtin: BUILTIN_WORKSPACES.map((w) => w.id), user, errors };
  }

  saveLayout(raw: unknown): { ok: true; ws: Workspace } | { ok: false; error: string } {
    const r = validateWorkspace(raw);
    if (!r.ok) return r;
    this.writeFile(path.join(this.paths.layouts, `${r.ws.id}.json`), JSON.stringify(r.ws, null, 2) + '\n');
    this.emit('assets', 'layouts');
    return r;
  }

  deleteLayout(id: string): boolean {
    const file = path.join(this.paths.layouts, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    this.backupFile(file, `layout-${id}`);
    fs.rmSync(file);
    this.emit('assets', 'layouts');
    return true;
  }

  // ───────────────────────── presets ─────────────────────────

  listPresets(): PresetListing {
    const presets: Preset[] = [];
    const errors: PresetListing['errors'] = [];
    for (const name of safeReaddir(this.paths.presets)) {
      if (!name.endsWith('.json')) continue;
      try {
        const r = PresetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(this.paths.presets, name), 'utf8')));
        if (r.success) presets.push({ ...r.data, builtin: false });
        else errors.push({ file: name, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 4).join('; ') });
      } catch (e) {
        errors.push({ file: name, error: (e as Error).message.split('\n')[0] });
      }
    }
    return { presets, errors };
  }

  savePreset(raw: unknown): { ok: true; preset: Preset } | { ok: false; error: string } {
    const r = PresetSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ') };
    const preset = { ...r.data, builtin: undefined };
    this.writeFile(path.join(this.paths.presets, `${preset.id}.json`), JSON.stringify(preset, null, 2) + '\n');
    this.emit('assets', 'presets');
    return { ok: true, preset };
  }

  deletePreset(id: string): boolean {
    const file = path.join(this.paths.presets, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    this.backupFile(file, `preset-${id}`);
    fs.rmSync(file);
    this.emit('assets', 'presets');
    return true;
  }

  // ───────────────────────── import / export / backups ─────────────────────────

  exportBundle(): ExportBundle {
    const themes = this.listThemes();
    const layouts = this.listLayouts();
    return {
      format: 'synapse-ui-export',
      version: CONFIG_VERSION,
      exported: new Date().toISOString(),
      config: nestConfig(this.config),
      keybindings: { ...this.bindings },
      themes: themes.themes.filter((t) => themes.user.includes(t.id)).map(themeToFile),
      layouts: layouts.layouts.filter((l) => layouts.user.includes(l.id)),
      presets: this.listPresets().presets,
    };
  }

  importBundle(raw: unknown): { ok: boolean; summary: string[]; errors: string[] } {
    const errors: string[] = [];
    const summary: string[] = [];
    if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== 'synapse-ui-export') return { ok: false, summary, errors: ['not a SYNAPSE-UI export file'] };
    const b = raw as Partial<ExportBundle>;
    this.backup('config-before-import');
    if (b.config && typeof b.config === 'object') {
      const { config, issues } = validateConfig(b.config);
      for (const i of issues) errors.push(`config ${i.key}: ${i.message}`);
      const r = this.set(config);
      if (r.ok) summary.push(`${r.changed.length} settings`);
    }
    if (b.keybindings) {
      const r = this.saveKeybindings(b.keybindings);
      if (r.ok) summary.push('keybindings');
      else errors.push(...r.issues);
    }
    let n = 0;
    for (const t of b.themes ?? []) {
      const parsed = ThemeFileSchema.safeParse(t);
      if (!parsed.success) { errors.push(`theme: ${parsed.error.issues[0]?.message}`); continue; }
      const r = this.saveTheme(materializeTheme(parsed.data, (id) => this.listThemes().themes.find((x) => x.id === id)));
      if (r.ok) n++;
      else errors.push(`theme ${parsed.data.id}: ${r.error}`);
    }
    if (n) summary.push(`${n} themes`);
    n = 0;
    for (const l of b.layouts ?? []) {
      const r = this.saveLayout(l);
      if (r.ok) n++;
      else errors.push(`layout: ${r.error}`);
    }
    if (n) summary.push(`${n} layouts`);
    n = 0;
    for (const p of b.presets ?? []) {
      const r = this.savePreset(p);
      if (r.ok) n++;
      else errors.push(`preset: ${r.error}`);
    }
    if (n) summary.push(`${n} presets`);
    return { ok: errors.length === 0, summary, errors };
  }

  backup(label: string): string | null {
    return this.backupFile(this.paths.configFile, label);
  }

  private backupFile(file: string, label: string): string | null {
    try {
      if (!fs.existsSync(file)) return null;
      const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
      const ext = path.extname(file);
      let dest = path.join(this.paths.backups, `${stamp}_${label}${ext}`);
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(this.paths.backups, `${stamp}_${label}-${i}${ext}`);
      fs.copyFileSync(file, dest);
      this.pruneBackups();
      return dest;
    } catch (e) {
      log.warn('backup failed', e);
      return null;
    }
  }

  listBackups(): { name: string; size: number; mtime: number }[] {
    return safeReaddir(this.paths.backups)
      .map((name) => {
        try {
          const st = fs.statSync(path.join(this.paths.backups, name));
          return { name, size: st.size, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; size: number; mtime: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime);
  }

  restoreBackup(name: string): { ok: boolean; error?: string } {
    if (!/^[0-9TZ:._-]+_config[A-Za-z0-9-]*\.toml$/.test(name) || name.includes('/') || name.includes('\\')) return { ok: false, error: 'only config.toml backups can be restored here' };
    const file = path.join(this.paths.backups, name);
    if (!fs.existsSync(file)) return { ok: false, error: 'backup not found' };
    this.backup('config-before-restore');
    const text = fs.readFileSync(file, 'utf8');
    try {
      parseToml(text);
    } catch (e) {
      return { ok: false, error: `backup is not valid TOML: ${(e as Error).message.split('\n')[0]}` };
    }
    fs.writeFileSync(this.paths.configFile, text);
    this.loadConfigFile(true);
    return { ok: true };
  }

  private pruneBackups(): void {
    const keep = Math.max(1, Number(this.config['advanced.backup_count']) || 20);
    for (const b of this.listBackups().slice(keep)) {
      try { fs.rmSync(path.join(this.paths.backups, b.name)); } catch { /* ignore */ }
    }
  }

  // ───────────────────────── watching ─────────────────────────

  startWatching(): void {
    this.stopWatching();
    if (!this.config['advanced.watch_config']) return;
    const watch = (dir: string, onChange: (file: string) => void) => {
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
          if (!name) return;
          const file = path.join(dir, name.toString());
          const key = file;
          clearTimeout(this.debounce.get(key));
          this.debounce.set(key, setTimeout(() => {
            this.debounce.delete(key);
            if (this.isSelfWrite(file)) return;
            onChange(file);
          }, 150));
        });
        w.on('error', (e) => log.warn(`watcher on ${dir} failed`, e));
        this.watchers.push(w);
      } catch (e) {
        log.warn(`cannot watch ${dir}`, e);
      }
    };
    watch(this.paths.config, (file) => {
      if (file === this.paths.configFile) {
        log.info('config.toml changed on disk; reloading');
        this.backupFile(this.paths.configFile, 'config-external-edit');
        this.loadConfigFile(true);
      } else if (file === this.paths.keybindingsFile) {
        this.loadKeybindings(true);
      }
    });
    watch(this.paths.themes, () => this.emit('assets', 'themes'));
    watch(this.paths.layouts, () => this.emit('assets', 'layouts'));
    watch(this.paths.presets, () => this.emit('assets', 'presets'));
    watch(this.paths.modules, () => this.emit('assets', 'modules'));
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private isSelfWrite(file: string): boolean {
    const expected = this.lastWritten.get(file);
    if (expected === undefined) return false;
    try {
      return fs.readFileSync(file, 'utf8') === expected;
    } catch {
      return false;
    }
  }

  /** Atomic write (temp file + rename) so readers never see a partial file. */
  private writeFile(file: string, content: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.lastWritten.set(file, content);
  }
}

// ───────────────────────── helpers ─────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

export function themeToToml(theme: Theme): string {
  return emitTomlDocument(themeToFile(theme), [
    ...tomlComment(`SYNAPSE-UI theme "${theme.name}". Any key may be omitted: missing values are inherited from \`base\` (default "obsidian"). Colors accept #rgb, #rrggbb, #rrggbbaa or rgba(r,g,b,a). [modules.<type>] tables override tokens for one module type, e.g. [modules.terminal.colors].`),
  ]);
}

/**
 * Versioned config migrations. Format 1 is the first and current SYNAPSE-UI
 * format; files without `config_version` are treated as format 1. The
 * original eDEX-UI settings.json is migrated by importLegacyEdexSettings().
 *
 * To change the format: bump CONFIG_VERSION and add a step below
 * (`if (fromVersion < N) { …rename/convert keys…; notes.push(…) }`).
 * A backup is written automatically whenever a step produced notes.
 */
export const MIGRATIONS: { to: number; describe: string; run: (raw: Record<string, Record<string, unknown>>) => string[] }[] = [];

export function migrateConfig(raw: Record<string, unknown>, fromVersion: number): { raw: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, Record<string, unknown>>;
  for (const step of MIGRATIONS) if (fromVersion < step.to) notes.push(...step.run(out));
  delete (out as Record<string, unknown>).config_version;
  return { raw: out, notes };
}

/** Map an original eDEX-UI settings.json onto SYNAPSE-UI settings. */
export function importLegacyEdexSettings(file: string): { patch: Record<string, unknown> } | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const patch: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (str(raw.shell)) patch['terminal.default_shell'] = raw.shell;
  if (str(raw.shellArgs)?.trim()) patch['terminal.shell_args'] = (raw.shellArgs as string).trim().split(/\s+/);
  if (str(raw.cwd)) patch['terminal.cwd'] = raw.cwd;
  if (str(raw.keyboard) && /^[A-Za-z]{2}-[A-Za-z0-9-]{1,16}$/.test(raw.keyboard as string)) patch['keyboard.layout'] = raw.keyboard;
  if (str(raw.theme) && /^[a-z0-9-]+$/.test(raw.theme as string)) patch['application.theme'] = `edex-${raw.theme}`;
  if (typeof raw.termFontSize === 'number' && raw.termFontSize >= 6 && raw.termFontSize <= 40) patch['terminal.font_size'] = Math.round(raw.termFontSize);
  if (typeof raw.audio === 'boolean') patch['audio.ui_sounds'] = raw.audio;
  if (typeof raw.audioVolume === 'number') patch['audio.volume'] = Math.max(0, Math.min(1, raw.audioVolume));
  if (typeof raw.disableFeedbackAudio === 'boolean') patch['audio.feedback_sounds'] = !raw.disableFeedbackAudio;
  if (raw.clockHours === 12 || raw.clockHours === 24) patch['monitoring.clock_24h'] = raw.clockHours === 24;
  if (typeof raw.nointro === 'boolean') patch['application.boot_animation'] = !raw.nointro;
  if (typeof raw.nocursor === 'boolean') patch['interface.cursor_visible'] = !raw.nocursor;
  if (typeof raw.forceFullscreen === 'boolean') patch['application.fullscreen'] = raw.forceFullscreen;
  if (typeof raw.hideDotfiles === 'boolean') patch['filesystem.show_hidden'] = !raw.hideDotfiles;
  if (typeof raw.fsListView === 'boolean') patch['filesystem.list_view'] = raw.fsListView;
  // eDEX's `port` (the vulnerable WebSocket port) is intentionally not imported: SYNAPSE-UI has no such server.
  return { patch };
}

const README_TEXT = `SYNAPSE-UI configuration directory
==================================

config.toml          All settings (validated; invalid values fall back to defaults).
keybindings.toml     Keyboard shortcuts.
themes/*.toml        Themes. A file whose id matches a built-in theme overrides it.
layouts/*.json       Workspace profiles (written by the workspace editor).
animations/presets/  Animation presets (written by the animation editor).
modules/             Third-party modules (each in its own folder with manifest.json).
backups/             Automatic backups made before external edits, imports and resets.

Edits are picked up live while SYNAPSE-UI runs. See docs/CONFIGURATION.md in the
repository for the full reference.
`;

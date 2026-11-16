import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigService, importLegacyEdexSettings } from '../../src/main/config-service';
import { resolvePaths } from '../../src/main/paths';
import { SETTINGS, applyPatch, defaultConfig, emitConfigToml, validateConfig } from '../../src/shared/settings';
import { BUILTIN_THEMES } from '../../src/shared/theme';
import { BUILTIN_WORKSPACES } from '../../src/shared/profiles';

let dir: string;
const svc = (legacy?: string) => {
  const s = new ConfigService(resolvePaths({ SYNAPSE_CONFIG_DIR: dir }), legacy);
  s.init();
  return s;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings registry', () => {
  it('has unique keys and valid defaults', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const nested: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(defaultConfig())) {
      const [sec, name] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)];
      (nested[sec] ??= {})[name] = v;
    }
    expect(validateConfig(nested).issues).toEqual([]);
  });

  it('round-trips through the commented TOML emitter', () => {
    const cfg = defaultConfig();
    cfg['terminal.env'] = { FOO: 'bar "quoted"', PATH_EXTRA: '/opt/x' };
    cfg['terminal.shell_args'] = ['--norc', '-i'];
    cfg['colors.accent'] = 'rgba(10,20,30,0.5)';
    cfg['application.name'] = 'Weird \\ name\n';
    const text = emitConfigToml(cfg);
    expect(text).toContain('# SYNAPSE-UI configuration');
    const { config, issues } = validateConfig(parseToml(text));
    expect(issues.filter((i) => i.key !== 'application.name')).toEqual([]);
    expect(config['terminal.env']).toEqual(cfg['terminal.env']);
    expect(config['terminal.shell_args']).toEqual(['--norc', '-i']);
    expect(config['colors.accent']).toBe('rgba(10,20,30,0.5)');
  });

  it('falls back per field and reports invalid values', () => {
    const { config, issues } = validateConfig({ performance: { target_fps: 9999, mode: 'turbo' }, terminal: { font_size: 15 }, bogus: { x: 1 } });
    expect(config['performance.target_fps']).toBe(60);
    expect(config['performance.mode']).toBe('adaptive');
    expect(config['terminal.font_size']).toBe(15);
    expect(issues.map((i) => i.key).sort()).toEqual(['bogus.x', 'performance.mode', 'performance.target_fps']);
  });

  it('rejects malicious or malformed values', () => {
    const base = defaultConfig();
    expect(applyPatch(base, { 'terminal.env': { 'BAD-KEY': 'x' } }).ok).toBe(false);
    expect(applyPatch(base, { 'terminal.env': { __proto__: 'x' } as Record<string, string> }).ok).toBe(true);
    expect(applyPatch(base, { 'application.theme': '../../etc/passwd' }).ok).toBe(false);
    expect(applyPatch(base, { 'application.name': 'a\u0007bell' }).ok).toBe(false);
    expect(applyPatch(base, { 'colors.background': 'red; background:url(x)' }).ok).toBe(false);
    expect(applyPatch(base, { 'terminal.shell_args': 'not-an-array' }).ok).toBe(false);
    expect(applyPatch(base, { 'not.a.setting': 1 }).ok).toBe(false);
    expect(applyPatch(base, { 'terminal.scrollback': 1.5 }).ok).toBe(false);
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });
});

describe('ConfigService', () => {
  it('creates the XDG-style layout on first run', () => {
    const s = svc();
    expect(s.firstRun).toBe(true);
    for (const f of ['config.toml', 'keybindings.toml', 'themes/custom.toml', 'README.txt']) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    for (const d of ['layouts', 'modules', 'animations/presets', 'backups']) expect(fs.statSync(path.join(dir, d)).isDirectory()).toBe(true);
  });

  it('saves GUI changes to config.toml and loads them again', () => {
    const s = svc();
    const r = s.set({ 'application.theme': 'crimson-protocol', 'terminal.font_size': 17 });
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    expect(text).toContain('theme = "crimson-protocol"');
    const again = svc();
    expect(again.firstRun).toBe(false);
    expect(again.get('application.theme')).toBe('crimson-protocol');
    expect(again.get('terminal.font_size')).toBe(17);
  });

  it('keeps previous settings when config.toml has a syntax error', () => {
    const s = svc();
    s.set({ 'terminal.font_size': 19 });
    fs.writeFileSync(path.join(dir, 'config.toml'), '[terminal\nfont_size = = 3');
    const again = new ConfigService(resolvePaths({ SYNAPSE_CONFIG_DIR: dir }));
    again.config['terminal.font_size'] = 19;
    again.init();
    expect(again.issues[0].message).toMatch(/syntax error/);
    expect(again.get('terminal.font_size')).toBe(19);
  });

  it('applies external edits live and backs up the previous file', async () => {
    const s = svc();
    s.startWatching();
    const changed = new Promise<string[]>((resolve) => s.on('changed', (e: { changed: string[] }) => resolve(e.changed)));
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('font_size = 13', 'font_size = 21'));
    const keys = await changed;
    s.stopWatching();
    expect(keys).toContain('terminal.font_size');
    expect(s.get('terminal.font_size')).toBe(21);
    expect(s.listBackups().some((b) => b.name.includes('external-edit'))).toBe(true);
  });

  it('ignores its own writes when watching', async () => {
    const s = svc();
    s.startWatching();
    let external = 0;
    s.on('changed', (e: { source: string }) => { if (e.source === 'file') external++; });
    s.set({ 'audio.volume': 0.3 });
    await new Promise((r) => setTimeout(r, 400));
    s.stopWatching();
    expect(external).toBe(0);
  });

  it('protects against configs from a newer format', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), 'config_version = 99\n[terminal]\nfont_size = 14\n[future]\nthing = 1\n');
    const s = svc();
    expect(s.get('terminal.font_size')).toBe(14);
    expect(s.issues.some((i) => i.key === 'config_version')).toBe(true);
    expect(s.listBackups().some((b) => b.name.includes('newer-version'))).toBe(true);
  });

  it('migrates an original eDEX-UI settings.json on first run', () => {
    const legacy = path.join(dir, 'edex-settings.json');
    fs.writeFileSync(legacy, JSON.stringify({ shell: 'zsh', shellArgs: '-l -i', theme: 'blade', termFontSize: 16, audio: false, clockHours: 12, nointro: true, nocursor: true, hideDotfiles: true, fsListView: true, keyboard: 'fr-FR', port: 3000 }));
    const s = svc(legacy);
    expect(s.legacyImported).toBe(legacy);
    expect(s.get('terminal.default_shell')).toBe('zsh');
    expect(s.get('terminal.shell_args')).toEqual(['-l', '-i']);
    expect(s.get('application.theme')).toBe('edex-blade');
    expect(s.get('terminal.font_size')).toBe(16);
    expect(s.get('audio.ui_sounds')).toBe(false);
    expect(s.get('monitoring.clock_24h')).toBe(false);
    expect(s.get('application.boot_animation')).toBe(false);
    expect(s.get('interface.cursor_visible')).toBe(false);
    expect(s.get('filesystem.show_hidden')).toBe(false);
    expect(s.get('keyboard.layout')).toBe('fr-FR');
    expect(importLegacyEdexSettings(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('manages themes, layouts, presets and keybindings', () => {
    const s = svc();
    const theme = { ...structuredClone(BUILTIN_THEMES[0]), id: 'my-theme', name: 'Mine' };
    theme.colors.accent = '#ff00ff';
    expect(s.saveTheme(theme).ok).toBe(true);
    expect(s.listThemes().themes.find((t) => t.id === 'my-theme')?.colors.accent).toBe('#ff00ff');
    // partial user theme inherits from its base
    fs.writeFileSync(path.join(dir, 'themes', 'partial.toml'), 'id = "partial"\nname = "Partial"\nbase = "terminal-green"\n[colors]\naccent = "#123456"\n');
    const partial = s.listThemes().themes.find((t) => t.id === 'partial')!;
    expect(partial.colors.accent).toBe('#123456');
    expect(partial.colors.foreground).toBe(BUILTIN_THEMES.find((t) => t.id === 'terminal-green')!.colors.foreground);
    // malicious theme values are rejected
    fs.writeFileSync(path.join(dir, 'themes', 'evil.toml'), 'id = "evil"\nname = "Evil"\n[effects]\nbackground_gradient = "url(https://evil.example/x.png)"\n');
    expect(s.listThemes().errors.some((e) => e.file === 'evil.toml')).toBe(true);
    expect(s.deleteTheme('my-theme')).toBe(true);

    const ws = { ...structuredClone(BUILTIN_WORKSPACES[1]), id: 'mine', name: 'Mine' };
    expect(s.saveLayout(ws).ok).toBe(true);
    expect(s.listLayouts().layouts.find((l) => l.id === 'mine')?.modules.length).toBe(ws.modules.length);
    expect(s.saveLayout({ ...ws, mode: 'sideways' }).ok).toBe(false);

    expect(s.savePreset({ id: 'my-preset', name: 'My preset', engine: 'neural-sphere', params: { rate: 0.02 } }).ok).toBe(true);
    expect(s.listPresets().presets.map((p) => p.id)).toContain('my-preset');

    expect(s.saveKeybindings({ 'workspace.editor': 'Ctrl+Alt+E' }).ok).toBe(true);
    expect(s.bindings['workspace.editor']).toBe('Ctrl+Alt+E');
    expect(s.saveKeybindings({ 'workspace.editor': 'Ctrl+Nope+E' }).ok).toBe(false);
  });

  it('exports and imports a complete bundle', () => {
    const a = svc();
    a.set({ 'application.theme': 'ultraviolet' });
    a.saveTheme({ ...structuredClone(BUILTIN_THEMES[1]), id: 'exported', name: 'Exported' });
    a.savePreset({ id: 'p1', name: 'P1', engine: 'particles', params: {} });
    const bundle = a.exportBundle();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-test-'));
    const b = svc();
    const r = b.importBundle(JSON.parse(JSON.stringify(bundle)));
    expect(r.errors).toEqual([]);
    expect(b.get('application.theme')).toBe('ultraviolet');
    expect(b.listThemes().user).toContain('exported');
    expect(b.listPresets().presets.map((p) => p.id)).toContain('p1');
    expect(b.importBundle({ format: 'something-else' }).ok).toBe(false);
  });

  it('backs up and restores config.toml and resets to defaults', () => {
    const s = svc();
    s.set({ 'terminal.font_size': 22 });
    const backup = s.backup('manual')!;
    s.set({ 'terminal.font_size': 9 });
    expect(s.restoreBackup(path.basename(backup)).ok).toBe(true);
    expect(s.get('terminal.font_size')).toBe(22);
    expect(s.restoreBackup('../../etc/passwd').ok).toBe(false);
    s.reset(null);
    expect(s.get('terminal.font_size')).toBe(13);
  });
});

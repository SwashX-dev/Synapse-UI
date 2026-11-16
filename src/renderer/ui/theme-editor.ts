/**
 * Graphical theme editor: every token, live preview, per-module-type
 * overrides, workspace-specific overrides, undo/redo, presets (save / save
 * as / duplicate / delete), import/export and reset.
 */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { debounce, h } from '../core/util';
import { applyOverride, ThemeSchema, type Theme, type ThemeOverride } from '../../shared/theme';
import { History, clone } from '../../shared/workspace';
import { colorInput, field, paramInput } from './form';
import { moduleTypes } from '../workspace/module';
import type { ParamSpec } from '../../shared/manifest';

const COLOR_KEYS = ['background', 'surface', 'foreground', 'text', 'text_dim', 'border', 'accent', 'highlight', 'glow', 'shadow', 'selection', 'ok', 'warning', 'danger', 'particle', 'neural', 'neural_pulse'] as const;
const TERM_KEYS = ['background', 'foreground', 'cursor', 'cursor_accent', 'selection', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bright_black', 'bright_red', 'bright_green', 'bright_yellow', 'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_white'] as const;
const FONTS = ['United Sans Medium', 'United Sans Light', 'Fira Mono', 'Fira Code'];

const EFFECTS: ParamSpec[] = [
  { key: 'border_width', label: 'Border thickness', type: 'number', default: 1, min: 0, max: 6, step: 0.5 },
  { key: 'border_alpha', label: 'Border transparency', type: 'number', default: 0.55, min: 0, max: 1, step: 0.01 },
  { key: 'glow_intensity', label: 'Glow intensity', type: 'number', default: 0.35, min: 0, max: 2, step: 0.01 },
  { key: 'shadow_intensity', label: 'Shadow intensity', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
  { key: 'panel_alpha', label: 'Panel opacity', type: 'number', default: 0.86, min: 0, max: 1, step: 0.01 },
  { key: 'background_gradient', label: 'Background gradient (CSS)', type: 'string', default: '' },
  { key: 'grid_pattern', label: 'eDEX background grid', type: 'bool', default: true },
  { key: 'grid_size', label: 'Grid size (px)', type: 'number', default: 22, min: 4, max: 200, step: 1 },
  { key: 'scanlines', label: 'Scanlines', type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
  { key: 'corner_accents', label: 'Corner accents', type: 'bool', default: true },
  { key: 'backdrop_blur', label: 'Floating panel blur (px)', type: 'number', default: 0, min: 0, max: 40, step: 1 },
];
const TYPO: ParamSpec[] = [
  { key: 'font_size', label: 'Font size (px)', type: 'number', default: 11, min: 8, max: 24, step: 0.5 },
  { key: 'letter_spacing', label: 'Letter spacing (em)', type: 'number', default: 0.06, min: -0.1, max: 0.5, step: 0.005 },
  { key: 'font_weight', label: 'Font weight', type: 'int', default: 400, min: 100, max: 900, step: 100 },
  { key: 'font_smoothing', label: 'Font rendering', type: 'select', default: 'antialiased', options: [{ value: 'antialiased', label: 'Grayscale antialiasing' }, { value: 'subpixel', label: 'Subpixel' }, { value: 'none', label: 'None (crisp)' }] },
  { key: 'uppercase_titles', label: 'Uppercase titles', type: 'bool', default: true },
];
const SPACING: ParamSpec[] = [
  { key: 'panel_gap', label: 'Element spacing (px)', type: 'number', default: 6, min: 0, max: 64, step: 1 },
  { key: 'panel_padding', label: 'Panel padding (px)', type: 'number', default: 8, min: 0, max: 64, step: 1 },
  { key: 'radius', label: 'Corner radius (px)', type: 'number', default: 0, min: 0, max: 24, step: 1 },
];

export function openThemeEditor(app: App): void {
  const p = app.overlays.panel('theme-editor', 'THEME EDITOR', { width: 'min(980px, 94vw)', height: 'min(88vh, 960px)', className: 'theme-editor', subtitle: 'changes preview live' });
  const startTheme = app.resolveTheme(null);
  let theme: Theme = clone(app.theme(app.get<string>('application.theme')) ?? startTheme);
  let scope: 'global' | 'workspace' = 'global';
  let wsOverride: ThemeOverride = clone(app.workspace.current?.themeOverride ?? {});
  let moduleTarget = '';
  let saved = false;
  const history = new History<Theme>(200);
  const body = h('div.te-body.scroll');
  const preview = debounce(() => app.applyTheme(scope === 'workspace' ? applyOverride(app.resolveTheme({ ...app.workspace.current!, themeOverride: undefined }), wsOverride) : theme), 25);
  const change = (fn: (t: Theme) => void) => {
    history.push(theme);
    if (scope === 'workspace') {
      const tmp = clone(app.resolveTheme({ ...app.workspace.current!, themeOverride: undefined }));
      const before = clone(applyOverride(tmp, wsOverride));
      fn(before);
      wsOverride = {
        colors: diff(tmp.colors, before.colors), effects: diff(tmp.effects, before.effects), typography: diff(tmp.typography, before.typography), spacing: diff(tmp.spacing, before.spacing),
      } as ThemeOverride;
    } else fn(theme);
    preview();
  };

  const baseSel = h('select', ...app.themes.map((t) => h('option', { value: t.id }, t.name)));
  baseSel.value = theme.id;
  baseSel.addEventListener('change', () => { history.push(theme); theme = clone(app.theme(baseSel.value)!); moduleTarget = ''; preview(); render(); });
  const scopeSel = h('select', h('option', { value: 'global' }, 'Edit theme (global)'), h('option', { value: 'workspace' }, `Override for workspace "${app.workspace.current?.name}"`));
  scopeSel.addEventListener('change', () => { scope = scopeSel.value as 'global' | 'workspace'; render(); preview(); });
  const modSel = h('select', h('option', { value: '' }, 'All modules'), ...moduleTypes().map((t) => h('option', { value: t.manifest.id }, `Only: ${t.manifest.name}`)));
  modSel.addEventListener('change', () => { moduleTarget = modSel.value; render(); });
  const name = h('input', { value: theme.name, spellcheck: 'false', title: 'Theme name' });
  name.addEventListener('change', () => change((t) => (t.name = name.value.trim().slice(0, 64) || t.name)));

  const save = async (asNew: boolean) => {
    if (scope === 'workspace') {
      const ws = app.workspace.current;
      if (!ws) return;
      app.workspace.apply({ ...clone(ws), themeOverride: wsOverride });
      saved = true;
      app.overlays.toast('Workspace theme override saved', 'ok');
      return;
    }
    let t = clone(theme);
    if (asNew) {
      const nm = await app.overlays.prompt({ title: 'Save theme as', label: 'Theme name', value: `${theme.name} copy` });
      if (!nm) return;
      t = { ...t, name: nm.trim().slice(0, 64), id: nm.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'theme' };
    }
    const r = await bridge.config.saveTheme(ThemeSchema.parse(t));
    if (!r.ok) return app.overlays.toast(`Theme not saved: ${r.error}`, 'error');
    await app.reloadThemes();
    await app.set({ 'application.theme': r.theme.id });
    theme = clone(r.theme);
    saved = true;
    app.applyTheme();
    app.sounds.play('theme');
    app.overlays.toast(`Saved theme "${r.theme.name}" → themes/${r.theme.id}.toml`, 'ok');
    render();
  };

  const toolbar = h('div.te-toolbar.row.wrap',
    h('span.label', 'BASE'), baseSel, name, scopeSel, modSel,
    h('button', { title: 'Undo', onclick: () => { const prev = history.undo(theme); if (prev) { theme = prev; preview(); render(); } } }, '↶'),
    h('button', { title: 'Redo', onclick: () => { const n = history.redo(theme); if (n) { theme = n; preview(); render(); } } }, '↷'),
    h('button', { title: 'Revert all changes', onclick: () => { history.push(theme); theme = clone(app.theme(baseSel.value) ?? startTheme); wsOverride = clone(app.workspace.current?.themeOverride ?? {}); preview(); render(); } }, 'RESET'),
    h('button', { onclick: async () => { const r = await bridge.config.importTheme(); if (r?.ok) { await app.reloadThemes(); theme = clone(r.theme); baseSel.replaceChildren(...app.themes.map((t) => h('option', { value: t.id }, t.name))); baseSel.value = theme.id; preview(); render(); } else if (r) app.overlays.toast(r.error, 'error'); } }, 'IMPORT'),
    h('button', { onclick: () => void bridge.config.exportTheme(theme.id).then((pth) => pth && app.overlays.toast(`Exported ${pth}`, 'ok')) }, 'EXPORT'),
    h('button', { onclick: () => void save(true) }, 'DUPLICATE / SAVE AS'),
    h('button.primary', { onclick: () => void save(false) }, 'SAVE'),
  );
  p.body.append(toolbar, body);
  p.onClose(() => { if (!saved) app.applyTheme(); });

  const cur = (): Theme => {
    let t = scope === 'workspace' ? applyOverride(app.resolveTheme({ ...app.workspace.current!, themeOverride: undefined }), wsOverride) : theme;
    if (moduleTarget && scope === 'global') t = applyOverride(t, theme.modules[moduleTarget]);
    return t;
  };
  /** Write a token either to the theme or to the selected module-type override. */
  const setToken = (section: 'colors' | 'effects' | 'typography' | 'spacing', key: string, value: unknown) => change((t) => {
    if (moduleTarget && scope === 'global') {
      const o = (t.modules[moduleTarget] ??= {});
      (o[section] as Record<string, unknown>) = { ...(o[section] as Record<string, unknown> | undefined), [key]: value };
    } else (t[section] as Record<string, unknown>)[key] = value;
  });

  function render(): void {
    const t = cur();
    const sec = (title: string, ...rows: (HTMLElement | string)[]) => h('section.te-section', h('h4', title), ...rows);
    const colorRows = COLOR_KEYS.map((k) => field(k.replace(/_/g, ' ').toUpperCase(), colorInput(t.colors[k], (v) => setToken('colors', k, v))));
    const graph = h('div.row.wrap', ...t.colors.graph.map((c, i) => colorInput(c, (v) => change((th) => { const g = [...(moduleTarget ? (th.modules[moduleTarget]?.colors?.graph ?? th.colors.graph) : th.colors.graph)]; g[i] = v; setTokenRaw(th, 'graph', g); }))),
      h('button.ghost', { onclick: () => change((th) => setTokenRaw(th, 'graph', [...th.colors.graph, th.colors.foreground].slice(0, 8))) }, '+'),
      h('button.ghost', { onclick: () => change((th) => setTokenRaw(th, 'graph', th.colors.graph.slice(0, Math.max(1, th.colors.graph.length - 1)))) }, '−'));
    const setTokenRaw = (th: Theme, key: 'graph', v: string[]) => {
      if (moduleTarget && scope === 'global') { const o = (th.modules[moduleTarget] ??= {}); o.colors = { ...o.colors, [key]: v }; }
      else th.colors[key] = v;
    };
    const specRows = (section: 'effects' | 'typography' | 'spacing', specs: ParamSpec[]) => specs.map((s) => field(s.label, paramInput(s, (t[section] as Record<string, unknown>)[s.key], (v) => setToken(section, s.key, v))));
    const fontSel = (key: 'ui_font' | 'ui_font_light' | 'mono_font') => {
      const inp = h('input', { value: t.typography[key], list: 'te-fonts', spellcheck: 'false' });
      inp.addEventListener('change', () => setToken('typography', key, inp.value.trim()));
      return inp;
    };
    body.replaceChildren(
      h('datalist#te-fonts', ...FONTS.map((f) => h('option', { value: f }))),
      moduleTarget && scope === 'global' ? h('p.dim', `Editing overrides that apply only to "${moduleTarget}" modules (stored in [modules.${moduleTarget}]).`) : scope === 'workspace' ? h('p.dim', 'Editing overrides stored in this workspace (layouts/*.json). They apply on top of the global theme whenever this workspace is active.') : '',
      sec('COLORS', ...colorRows, field('GRAPH PALETTE', graph)),
      sec('EFFECTS', ...specRows('effects', EFFECTS)),
      sec('TYPOGRAPHY', field('UI FONT', fontSel('ui_font')), field('UI FONT (LIGHT)', fontSel('ui_font_light')), field('MONOSPACE FONT', fontSel('mono_font')), ...specRows('typography', TYPO)),
      sec('SPACING', ...specRows('spacing', SPACING)),
      sec('ANIMATION', field('Interface animation speed', paramInput({ key: 'speed', label: '', type: 'number', default: 1, min: 0, max: 4, step: 0.05 }, t.animation.speed, (v) => change((th) => (th.animation.speed = Number(v)))))),
      scope === 'global' && !moduleTarget ? sec('TERMINAL PALETTE', ...TERM_KEYS.map((k) => field(k.replace(/_/g, ' ').toUpperCase(), colorInput(theme.terminal[k], (v) => change((th) => (th.terminal[k] = v)))))) : '',
    );
  }
  render();
}

function diff<T extends object>(base: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) if (JSON.stringify(base[k]) !== JSON.stringify(next[k])) out[k] = next[k];
  return out;
}

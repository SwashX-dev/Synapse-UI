/**
 * Theme model. A theme coordinates the whole application: interface colors,
 * typography, spacing, effects, terminal palette and visualization colors,
 * with optional per-module-type overrides.
 */
import { z } from 'zod';
import { isColor } from './settings';

const color = z.string().max(64).refine(isColor, { message: 'expected a color like "#rrggbb" or "rgba(r,g,b,a)"' });
const fontName = z.string().max(128).regex(/^[A-Za-z0-9 _.,'"-]*$/, 'font names may only contain letters, digits, spaces and , . _ - \' "');
const gradient = z
  .string()
  .max(512)
  .regex(/^(|none|(linear|radial|conic)-gradient\([#a-zA-Z0-9 ,.%()-]*\))$/, 'expected "", "none" or a CSS linear/radial/conic-gradient()');

export const ThemeColorsSchema = z.object({
  background: color,
  surface: color,
  foreground: color,
  text: color,
  text_dim: color,
  border: color,
  accent: color,
  highlight: color,
  glow: color,
  shadow: color,
  selection: color,
  ok: color,
  warning: color,
  danger: color,
  graph: z.array(color).min(1).max(8),
  particle: color,
  neural: color,
  neural_pulse: color,
});

export const ThemeEffectsSchema = z.object({
  border_width: z.number().min(0).max(6),
  border_alpha: z.number().min(0).max(1),
  glow_intensity: z.number().min(0).max(2),
  shadow_intensity: z.number().min(0).max(1),
  panel_alpha: z.number().min(0).max(1),
  background_gradient: gradient,
  grid_pattern: z.boolean(),
  grid_size: z.number().min(4).max(200),
  scanlines: z.number().min(0).max(1),
  corner_accents: z.boolean(),
  backdrop_blur: z.number().min(0).max(40),
});

export const ThemeTypographySchema = z.object({
  ui_font: fontName,
  ui_font_light: fontName,
  mono_font: fontName,
  font_size: z.number().min(8).max(24),
  letter_spacing: z.number().min(-0.1).max(0.5),
  font_weight: z.number().int().min(100).max(900),
  font_smoothing: z.enum(['antialiased', 'subpixel', 'none']),
  uppercase_titles: z.boolean(),
});

export const ThemeSpacingSchema = z.object({
  panel_gap: z.number().min(0).max(64),
  panel_padding: z.number().min(0).max(64),
  radius: z.number().min(0).max(24),
});

export const ThemeTerminalSchema = z.object({
  background: color,
  foreground: color,
  cursor: color,
  cursor_accent: color,
  selection: color,
  black: color, red: color, green: color, yellow: color, blue: color, magenta: color, cyan: color, white: color,
  bright_black: color, bright_red: color, bright_green: color, bright_yellow: color, bright_blue: color, bright_magenta: color, bright_cyan: color, bright_white: color,
});

export const ThemeOverrideSchema = z.object({
  colors: ThemeColorsSchema.partial().optional(),
  effects: ThemeEffectsSchema.partial().optional(),
  typography: ThemeTypographySchema.partial().optional(),
  spacing: ThemeSpacingSchema.partial().optional(),
  animation: z.object({ speed: z.number().min(0).max(4) }).partial().optional(),
});
export type ThemeOverride = z.infer<typeof ThemeOverrideSchema>;

export const ThemeSchema = z.object({
  format: z.literal(1).default(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
  author: z.string().max(128).default(''),
  colors: ThemeColorsSchema,
  effects: ThemeEffectsSchema,
  typography: ThemeTypographySchema,
  spacing: ThemeSpacingSchema,
  animation: z.object({ speed: z.number().min(0).max(4) }),
  terminal: ThemeTerminalSchema,
  /** Per-module-type overrides, keyed by module type id (e.g. "terminal", "cpu"). */
  modules: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), ThemeOverrideSchema).default({}),
});
export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeColors = Theme['colors'];

/** A partial theme file as stored on disk: only `id`/`name` are required; the rest inherits from `base`. */
export const ThemeFileSchema = ThemeOverrideSchema.extend({
  format: z.literal(1).optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: z.string().min(1).max(64),
  base: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
  description: z.string().max(512).optional(),
  author: z.string().max(128).optional(),
  terminal: ThemeTerminalSchema.partial().optional(),
  modules: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), ThemeOverrideSchema).optional(),
});
export type ThemeFile = z.infer<typeof ThemeFileSchema>;

// ───────────────────────────── color helpers ─────────────────────────────

export function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const s = input.trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), bl = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b: bl, a };
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p));
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function withAlpha(colorStr: string, alpha: number): string {
  const { r, g, b } = parseColor(colorStr);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a), y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

// ───────────────────────────── built-in themes ─────────────────────────────

const BASE_TYPO: Theme['typography'] = {
  ui_font: 'United Sans Medium',
  ui_font_light: 'United Sans Light',
  mono_font: 'Fira Mono',
  font_size: 11,
  letter_spacing: 0.06,
  font_weight: 400,
  font_smoothing: 'antialiased',
  uppercase_titles: true,
};
const BASE_EFFECTS: Theme['effects'] = {
  border_width: 1,
  border_alpha: 0.55,
  glow_intensity: 0.35,
  shadow_intensity: 0.5,
  panel_alpha: 0.86,
  background_gradient: '',
  grid_pattern: true,
  grid_size: 22,
  scanlines: 0,
  corner_accents: true,
  backdrop_blur: 0,
};
const BASE_SPACING: Theme['spacing'] = { panel_gap: 6, panel_padding: 8, radius: 0 };

function terminalFrom(bg: string, fg: string, accent: string, mono: boolean): Theme['terminal'] {
  if (mono) {
    // Monochrome-leaning palette that keeps ANSI colors distinguishable but desaturated.
    return {
      background: bg, foreground: fg, cursor: fg, cursor_accent: bg, selection: withAlpha(fg, 0.25),
      black: '#1a1a1a', red: '#d87a7a', green: '#a9c9a9', yellow: '#d6cfa4', blue: '#9fb3c8', magenta: '#c2a8c8', cyan: '#a6c8c8', white: '#d4d4d4',
      bright_black: '#5a5a5a', bright_red: '#f09a9a', bright_green: '#c8e6c8', bright_yellow: '#efe8c0', bright_blue: '#c0d2e4', bright_magenta: '#dcc6e2', bright_cyan: '#c6e4e4', bright_white: '#ffffff',
    };
  }
  return {
    background: bg, foreground: fg, cursor: accent, cursor_accent: bg, selection: withAlpha(accent, 0.3),
    black: mix(bg, '#000000', 0.5), red: '#ff5c57', green: '#5af78e', yellow: '#f3f99d', blue: '#57c7ff', magenta: '#ff6ac1', cyan: '#9aedfe', white: mix(fg, '#ffffff', 0.3),
    bright_black: mix(fg, bg, 0.6), bright_red: '#ff8080', bright_green: '#80ffaa', bright_yellow: '#ffffb0', bright_blue: '#80d4ff', bright_magenta: '#ff9ad8', bright_cyan: '#c0f6ff', bright_white: '#ffffff',
  };
}

interface Palette {
  id: string; name: string; description: string;
  bg: string; surface: string; fg: string; text: string; dim: string; border: string; accent: string; highlight: string; glow: string;
  neural: string; pulse: string; particle: string; graph: string[];
  ok?: string; warning?: string; danger?: string;
  mono?: boolean;
  effects?: Partial<Theme['effects']>;
  typography?: Partial<Theme['typography']>;
}

function makeTheme(p: Palette): Theme {
  return {
    format: 1,
    id: p.id,
    name: p.name,
    description: p.description,
    author: 'SYNAPSE-UI',
    colors: {
      background: p.bg, surface: p.surface, foreground: p.fg, text: p.text, text_dim: p.dim, border: p.border,
      accent: p.accent, highlight: p.highlight, glow: p.glow, shadow: '#000000', selection: withAlpha(p.accent, 0.28),
      ok: p.ok ?? '#7fd99a', warning: p.warning ?? '#e8c76a', danger: p.danger ?? '#ff4f4f',
      graph: p.graph, particle: p.particle, neural: p.neural, neural_pulse: p.pulse,
    },
    effects: { ...BASE_EFFECTS, ...p.effects },
    typography: { ...BASE_TYPO, ...p.typography },
    spacing: { ...BASE_SPACING },
    animation: { speed: 1 },
    terminal: terminalFrom(p.surface, p.text, p.accent, p.mono ?? false),
    modules: {},
  };
}

export const BUILTIN_THEMES: Theme[] = [
  makeTheme({
    id: 'obsidian', name: 'Obsidian', description: 'Monochromatic scientific laboratory: near-black ground, white and grayscale linework, fine glow.',
    bg: '#000000', surface: '#030303', fg: '#e8e8e8', text: '#d6d6d6', dim: '#6f6f6f', border: '#4a4a4a', accent: '#bbbbbb', highlight: '#ffffff', glow: '#ffffff',
    neural: '#d4dade', pulse: '#ffffff', particle: '#e6ecef', graph: ['#ffffff', '#a6a6a6', '#6c6c6c', '#d0d0d0', '#8a8a8a', '#505050'],
    ok: '#cfcfcf', warning: '#f0f0f0', danger: '#ff5a5a', mono: true,
    effects: { border_alpha: 0.6, grid_pattern: false, glow_intensity: 0.3 },
  }),
  makeTheme({
    id: 'edex-classic', name: 'eDEX Classic', description: 'The original eDEX-UI "tron" look: pale cyan on black with the signature background grid.',
    bg: '#000000', surface: '#05080d', fg: '#aacfd1', text: '#aacfd1', dim: '#557073', border: '#aacfd1', accent: '#aacfd1', highlight: '#e9fbfc', glow: '#aacfd1',
    neural: '#aacfd1', pulse: '#e9fbfc', particle: '#aacfd1', graph: ['#aacfd1', '#6f9294', '#d8f0f1', '#3f5859'],
    effects: { border_alpha: 0.4, grid_pattern: true, grid_size: 20 },
  }),
  makeTheme({
    id: 'crimson-protocol', name: 'Crimson Protocol', description: 'Black and deep red: an alert-state security console.',
    bg: '#030000', surface: '#090202', fg: '#ff4040', text: '#ffb3b3', dim: '#7a2a2a', border: '#7a1010', accent: '#d10f0f', highlight: '#ffdcdc', glow: '#ff1a1a',
    neural: '#ff3030', pulse: '#ffd0d0', particle: '#ff6060', graph: ['#ff3b3b', '#a31616', '#ff9a9a', '#5c0c0c'],
    ok: '#ff9a9a', warning: '#ffd166', danger: '#ffffff',
    effects: { grid_pattern: false, glow_intensity: 0.45 },
  }),
  makeTheme({
    id: 'cybernetic-blue', name: 'Cybernetic Blue', description: 'Electric blue linework over dark graphite.',
    bg: '#030509', surface: '#080d15', fg: '#4cc2ff', text: '#bfe6ff', dim: '#3f6680', border: '#1f4466', accent: '#00a6ff', highlight: '#e0f5ff', glow: '#1fb4ff',
    neural: '#45b8ff', pulse: '#dff4ff', particle: '#7fd0ff', graph: ['#4cc2ff', '#1a6fa6', '#a8e1ff', '#0b3b5c'],
    effects: { grid_pattern: true, grid_size: 26, border_alpha: 0.7 },
  }),
  makeTheme({
    id: 'terminal-green', name: 'Terminal Green', description: 'Phosphor green on black, with subtle scanlines.',
    bg: '#000300', surface: '#010801', fg: '#33ff66', text: '#a6ffbf', dim: '#2a7a40', border: '#145c27', accent: '#00d84a', highlight: '#e0ffe8', glow: '#33ff66',
    neural: '#2eff6a', pulse: '#d8ffe2', particle: '#5cff88', graph: ['#33ff66', '#178c38', '#a6ffbf', '#0b4a1d'],
    ok: '#a6ffbf', warning: '#f0ff80', danger: '#ff5050',
    effects: { scanlines: 0.25, grid_pattern: false, glow_intensity: 0.5 },
  }),
  makeTheme({
    id: 'ultraviolet', name: 'Ultraviolet', description: 'Violet scientific interface with lavender highlights.',
    bg: '#040109', surface: '#0a0414', fg: '#bf8cff', text: '#e4d0ff', dim: '#6a4a94', border: '#3a1f66', accent: '#8f45ff', highlight: '#f5ecff', glow: '#a862ff',
    neural: '#b47aff', pulse: '#f3e6ff', particle: '#d2a8ff', graph: ['#bf8cff', '#7a3fd6', '#e4d0ff', '#3d1d70'],
    effects: { background_gradient: 'radial-gradient(ellipse at 50% 40%, #10061f 0%, #040109 70%)', grid_pattern: false },
  }),
  makeTheme({
    id: 'ghost-white', name: 'Ghost White', description: 'Bright monochrome: intense white elements and strong glow over dark slate.',
    bg: '#0a0b0d', surface: '#111317', fg: '#ffffff', text: '#f5f7fa', dim: '#9aa1ab', border: '#b8bec7', accent: '#ffffff', highlight: '#ffffff', glow: '#ffffff',
    neural: '#ffffff', pulse: '#ffffff', particle: '#ffffff', graph: ['#ffffff', '#c7ccd3', '#8e959f', '#e6e9ed'],
    ok: '#ffffff', warning: '#e6e9ed', danger: '#ff6b6b', mono: true,
    effects: { border_alpha: 0.8, glow_intensity: 0.85, grid_pattern: true, grid_size: 30 },
  }),
];

/** "Custom" starts as a copy of Obsidian and is written to themes/custom.toml for editing. */
export const CUSTOM_THEME: Theme = { ...structuredCloneSafe(BUILTIN_THEMES[0]), id: 'custom', name: 'Custom', description: 'Your fully user-configurable theme. Edit it in Settings → Themes or in themes/custom.toml.' };
BUILTIN_THEMES.push(CUSTOM_THEME);

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ───────────────────────────── resolution ─────────────────────────────

export function applyOverride(theme: Theme, o: ThemeOverride | undefined): Theme {
  if (!o) return theme;
  return {
    ...theme,
    colors: { ...theme.colors, ...stripUndef(o.colors) },
    effects: { ...theme.effects, ...stripUndef(o.effects) },
    typography: { ...theme.typography, ...stripUndef(o.typography) },
    spacing: { ...theme.spacing, ...stripUndef(o.spacing) },
    animation: { ...theme.animation, ...stripUndef(o.animation) },
  };
}

function stripUndef<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** Turn a (partial) theme file into a full theme by inheriting from its base. */
export function materializeTheme(file: ThemeFile, lookup: (id: string) => Theme | undefined): Theme {
  const base = lookup(file.base ?? 'obsidian') ?? BUILTIN_THEMES[0];
  const merged = applyOverride(base, file);
  return ThemeSchema.parse({
    ...merged,
    format: 1,
    id: file.id,
    name: file.name,
    description: file.description ?? base.description,
    author: file.author ?? '',
    terminal: { ...base.terminal, ...stripUndef(file.terminal) },
    modules: { ...base.modules, ...(file.modules ?? {}) },
  });
}

/** Serialise a full theme for disk (TOML document object). */
export function themeToFile(theme: Theme): Record<string, unknown> {
  const { modules, ...rest } = theme;
  return { ...rest, ...(Object.keys(modules).length ? { modules } : {}) };
}

// ───────────────────────── legacy eDEX-UI theme import ─────────────────────────

export const LegacyEdexThemeSchema = z.object({
  colors: z.object({ r: z.number(), g: z.number(), b: z.number(), black: z.string().optional(), light_black: z.string().optional(), grey: z.string().optional() }),
  cssvars: z.object({ font_main: z.string().optional(), font_main_light: z.string().optional() }).optional(),
  terminal: z.object({
    fontFamily: z.string().optional(), cursorStyle: z.string().optional(), foreground: z.string().optional(), background: z.string().optional(),
    cursor: z.string().optional(), cursorAccent: z.string().optional(), selection: z.string().optional(),
  }).passthrough().optional(),
  globe: z.object({ base: z.string().optional(), marker: z.string().optional(), pin: z.string().optional(), satellite: z.string().optional() }).optional(),
  injectCSS: z.string().optional(),
});

/** Convert an original eDEX-UI theme JSON into a SYNAPSE theme (injectCSS is intentionally dropped). */
export function convertLegacyEdexTheme(id: string, name: string, raw: unknown): Theme {
  const t = LegacyEdexThemeSchema.parse(raw);
  const main = toHex(t.colors);
  const safe = (v: string | undefined, fb: string) => (v && isColor(v) ? v : fb);
  const bg = safe(t.colors.black, '#000000');
  const surface = safe(t.colors.light_black, '#05080d');
  const term = t.terminal ?? {};
  const font = (f: string | undefined, fb: string) => (f && /^[A-Za-z0-9 _.,'"-]*$/.test(f) ? f : fb);
  const theme = makeTheme({
    id, name, description: `Imported from the original eDEX-UI "${name.replace(/^eDEX: /, '')}" theme.`,
    bg, surface, fg: main, text: safe(term.foreground, main), dim: mix(main, bg, 0.55), border: main, accent: main, highlight: mix(main, '#ffffff', 0.6), glow: main,
    neural: safe(t.globe?.marker, main), pulse: mix(main, '#ffffff', 0.7), particle: safe(t.globe?.satellite, main),
    graph: [main, mix(main, bg, 0.4), mix(main, '#ffffff', 0.5), mix(main, bg, 0.7)],
    effects: { grid_pattern: true, border_alpha: 0.4 },
    typography: { ui_font: font(t.cssvars?.font_main, BASE_TYPO.ui_font), ui_font_light: font(t.cssvars?.font_main_light, BASE_TYPO.ui_font_light), mono_font: font(term.fontFamily, BASE_TYPO.mono_font) },
  });
  theme.terminal.background = safe(term.background, theme.terminal.background);
  theme.terminal.foreground = safe(term.foreground, theme.terminal.foreground);
  theme.terminal.cursor = safe(term.cursor, theme.terminal.cursor);
  theme.terminal.cursor_accent = safe(term.cursorAccent, theme.terminal.cursor_accent);
  theme.terminal.selection = safe(term.selection, theme.terminal.selection);
  return ThemeSchema.parse(theme);
}

/** CSS custom properties for a resolved theme. */
export function themeCssVars(t: Theme): Record<string, string> {
  const v: Record<string, string> = {
    '--bg': t.colors.background,
    '--surface': t.colors.surface,
    '--fg': t.colors.foreground,
    '--text': t.colors.text,
    '--text-dim': t.colors.text_dim,
    '--border': t.colors.border,
    '--accent': t.colors.accent,
    '--highlight': t.colors.highlight,
    '--glow': t.colors.glow,
    '--shadow': t.colors.shadow,
    '--selection': t.colors.selection,
    '--ok': t.colors.ok,
    '--warn': t.colors.warning,
    '--danger': t.colors.danger,
    '--particle': t.colors.particle,
    '--neural': t.colors.neural,
    '--pulse': t.colors.neural_pulse,
    '--border-w': `${t.effects.border_width}px`,
    '--border-a': String(t.effects.border_alpha),
    '--glow-i': String(t.effects.glow_intensity),
    '--shadow-i': String(t.effects.shadow_intensity),
    '--panel-a': String(t.effects.panel_alpha),
    '--bg-gradient': t.effects.background_gradient && t.effects.background_gradient !== 'none' ? t.effects.background_gradient : 'none',
    '--grid-size': `${t.effects.grid_size}px`,
    '--scanlines': String(t.effects.scanlines),
    '--backdrop-blur': `${t.effects.backdrop_blur}px`,
    '--font-ui': `"${t.typography.ui_font}", "United Sans Medium", sans-serif`,
    '--font-ui-light': `"${t.typography.ui_font_light}", "United Sans Light", sans-serif`,
    '--font-mono': `"${t.typography.mono_font}", "Fira Mono", monospace`,
    '--font-size': `${t.typography.font_size}px`,
    '--letter-spacing': `${t.typography.letter_spacing}em`,
    '--font-weight': String(t.typography.font_weight),
    '--title-transform': t.typography.uppercase_titles ? 'uppercase' : 'none',
    '--gap': `${t.spacing.panel_gap}px`,
    '--pad': `${t.spacing.panel_padding}px`,
    '--radius': `${t.spacing.radius}px`,
    '--anim-speed': String(t.animation.speed),
    '--corner-accents': t.effects.corner_accents ? '1' : '0',
  };
  t.colors.graph.forEach((g, i) => (v[`--graph-${i}`] = g));
  for (let i = t.colors.graph.length; i < 8; i++) v[`--graph-${i}`] = t.colors.graph[i % t.colors.graph.length];
  return v;
}

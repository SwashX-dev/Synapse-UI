/**
 * The settings registry is the single source of truth for SYNAPSE-UI's
 * `config.toml`. Every entry drives:
 *   - validation with per-field safe fallback (invalid value → default + error)
 *   - the generated, commented TOML file
 *   - the graphical settings interface (labels, descriptions, ranges)
 *
 * Rule: every setting listed here must have a real effect in the app.
 */
import { tomlComment, tomlKey, tomlValue, type TomlValue } from './toml';

export const CONFIG_VERSION = 1;

export const SETTINGS_CATEGORIES = [
  'GENERAL',
  'APPEARANCE',
  'THEMES',
  'WORKSPACES',
  'MODULES',
  'ANIMATIONS',
  'GRAPHICS',
  'PERFORMANCE',
  'TERMINAL',
  'MONITORING',
  'AUDIO',
  'KEYBINDINGS',
  'IMPORT / EXPORT',
  'ADVANCED',
  'ABOUT',
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export type DynamicOptions = 'themes' | 'workspaces' | 'shells' | 'presets' | 'kb_layouts' | 'audio_devices' | 'net_ifaces';

export type SettingType =
  | { kind: 'bool' }
  | { kind: 'number'; min: number; max: number; step?: number; int?: boolean; unit?: string }
  | { kind: 'enum'; options: readonly { value: string; label: string }[] }
  | { kind: 'string'; maxLength?: number; pattern?: RegExp; placeholder?: string; options?: DynamicOptions }
  | { kind: 'color'; optional: boolean }
  | { kind: 'string-list'; maxItems?: number }
  | { kind: 'string-map'; maxItems?: number };

export type SettingValue = boolean | number | string | string[] | Record<string, string>;

export interface SettingDef {
  key: string;
  type: SettingType;
  default: SettingValue;
  label: string;
  description: string;
  category: SettingsCategory;
  /** Hidden behind the "show advanced" toggle in the GUI. */
  advanced?: boolean;
  /** Only takes effect after restarting SYNAPSE-UI. */
  restart?: boolean;
  /** Not shown in the GUI (internal bookkeeping), still written to file. */
  hidden?: boolean;
  /** Only meaningful on these platforms (GUI hides otherwise). */
  platforms?: ('linux' | 'darwin' | 'win32')[];
}

const b = (key: string, def: boolean, category: SettingsCategory, label: string, description: string, extra: Partial<SettingDef> = {}): SettingDef => ({ key, type: { kind: 'bool' }, default: def, label, description, category, ...extra });
const n = (key: string, def: number, min: number, max: number, category: SettingsCategory, label: string, description: string, extra: Partial<SettingDef> & { step?: number; int?: boolean; unit?: string } = {}): SettingDef => {
  const { step, int, unit, ...rest } = extra;
  return { key, type: { kind: 'number', min, max, step: step ?? (int ? 1 : 0.01), int, unit }, default: def, label, description, category, ...rest };
};
const e = (key: string, def: string, options: [string, string][], category: SettingsCategory, label: string, description: string, extra: Partial<SettingDef> = {}): SettingDef => ({
  key,
  type: { kind: 'enum', options: options.map(([value, label]) => ({ value, label })) },
  default: def,
  label,
  description,
  category,
  ...extra,
});
const s = (key: string, def: string, category: SettingsCategory, label: string, description: string, extra: Partial<SettingDef> & { options?: DynamicOptions; maxLength?: number; pattern?: RegExp; placeholder?: string } = {}): SettingDef => {
  const { options, maxLength, pattern, placeholder, ...rest } = extra;
  return { key, type: { kind: 'string', options, maxLength: maxLength ?? 512, pattern, placeholder }, default: def, label, description, category, ...rest };
};
const c = (key: string, category: SettingsCategory, label: string, description: string): SettingDef => ({ key, type: { kind: 'color', optional: true }, default: '', label, description, category });

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SETTINGS: readonly SettingDef[] = [
  // ───────────────────────── application ─────────────────────────
  s('application.name', 'SYNAPSE-UI', 'GENERAL', 'Window title', 'Title shown in the window title bar and task switcher.', { maxLength: 64 }),
  s('application.theme', 'obsidian', 'GENERAL', 'Theme', 'Active theme id. Built-in themes can be overridden by a file with the same id in themes/.', { options: 'themes', pattern: ID }),
  s('application.workspace', 'neural-lab', 'GENERAL', 'Workspace', 'Active workspace profile id (a file in layouts/ or a built-in profile).', { options: 'workspaces', pattern: ID }),
  b('application.fullscreen', true, 'GENERAL', 'Fullscreen', 'Run as a fullscreen workstation. Toggle at any time with F11.'),
  b('application.frameless', false, 'GENERAL', 'Frameless window', 'Hide the operating-system window frame when windowed.', { restart: true }),
  n('application.display', -1, -1, 16, 'GENERAL', 'Display', 'Index of the monitor to open on (-1 = primary display).', { int: true, restart: true, advanced: true }),
  b('application.boot_animation', true, 'GENERAL', 'Boot sequence', 'Play the eDEX-style boot log and logo animation on startup.'),
  b('application.first_run_complete', false, 'GENERAL', 'First-run setup completed', 'Set to false to show the first-run setup again on next launch.', { hidden: true }),

  // ───────────────────────── interface ─────────────────────────
  n('interface.scale', 1, 0.5, 2.5, 'APPEARANCE', 'Interface scale', 'Zoom factor for the whole interface (useful on high-DPI or very large displays).', { step: 0.05 }),
  n('interface.panel_transparency', 0.1, 0, 1, 'APPEARANCE', 'Panel transparency', 'Additional transparency applied to every module background (0 = opaque theme value).'),
  b('interface.animations_enabled', true, 'APPEARANCE', 'Interface animations', 'Enable panel transitions, glows and other interface motion (visualizations are controlled separately).'),
  e('interface.reduced_motion', 'system', [['system', 'Follow system'], ['on', 'Always reduce'], ['off', 'Never reduce']], 'APPEARANCE', 'Reduced motion', 'When reduced, interface transitions are disabled, automatic camera motion slows and visualizations run at half speed.'),
  b('interface.show_titles', true, 'APPEARANCE', 'Module title bars', 'Show the thin technical title strip above each module.'),
  b('interface.cursor_visible', true, 'APPEARANCE', 'Mouse cursor', 'Show the mouse cursor (eDEX-UI "nocursor" equivalent when disabled).'),
  b('interface.notifications', true, 'APPEARANCE', 'Notifications', 'Show transient notifications for configuration reloads, errors and command results.'),
  e('interface.layout_mode', 'hybrid', [['grid', 'Grid'], ['freeform', 'Freeform'], ['hybrid', 'Hybrid']], 'WORKSPACES', 'Default layout mode', 'Layout mode given to newly created workspaces.'),
  b('interface.grid_snapping', true, 'WORKSPACES', 'Snapping', 'Snap floating modules to grid lines and to the edges of other modules while editing.'),
  n('interface.snap_threshold', 8, 2, 40, 'WORKSPACES', 'Snap distance', 'Distance in pixels at which edges snap together.', { int: true, unit: 'px' }),

  // ───────────────────────── performance ─────────────────────────
  e('performance.mode', 'adaptive', [['eco', 'Eco'], ['balanced', 'Balanced'], ['high', 'High'], ['cinematic', 'Cinematic'], ['adaptive', 'Adaptive']], 'PERFORMANCE', 'Performance profile', 'Eco minimises power, Cinematic maximises quality, Adaptive adjusts quality from measured frame times.'),
  n('performance.target_fps', 60, 15, 240, 'PERFORMANCE', 'Frame-rate limit', 'Upper bound for visualization frame rate. Individual modules may set lower limits.', { int: true, unit: 'fps' }),
  b('performance.adaptive_quality', true, 'PERFORMANCE', 'Adaptive resolution', 'Automatically scale render resolution down when frames take longer than the budget, and back up when there is headroom.'),
  n('performance.max_active_visualizations', 8, 1, 16, 'PERFORMANCE', 'Max simultaneous visualizations', 'Visualizations beyond this count (lowest priority first) are paused.', { int: true }),
  b('performance.suspend_hidden', true, 'PERFORMANCE', 'Suspend hidden modules', 'Stop rendering visualizations that are off-screen, fully transparent, covered or in an inactive workspace.'),
  b('performance.battery_saver', true, 'PERFORMANCE', 'Battery saver', 'Switch to the Eco profile while running on battery power.'),
  b('performance.show_fps', false, 'PERFORMANCE', 'Show FPS', 'Display a frame-rate readout in each visualization HUD.'),

  // ───────────────────────── graphics ─────────────────────────
  b('graphics.hardware_acceleration', true, 'GRAPHICS', 'Hardware acceleration', 'Use the GPU. Disable only if your driver crashes; visualizations will be very slow without it.', { restart: true }),
  n('graphics.resolution_scale', 1, 0.25, 2, 'GRAPHICS', 'Render resolution', 'Multiplier on device pixel ratio for all visualizations.', { step: 0.05 }),
  b('graphics.antialias', true, 'GRAPHICS', 'Antialiasing', 'Multisample antialiasing for the shared WebGL renderer. Changing it reinitialises graphics.'),
  e('graphics.power_preference', 'high-performance', [['high-performance', 'High performance (discrete GPU)'], ['low-power', 'Low power (integrated GPU)'], ['default', 'Browser default']], 'GRAPHICS', 'GPU preference', 'Which GPU to request on hybrid-graphics laptops. Changing it reinitialises graphics.'),
  b('graphics.ignore_gpu_blocklist', true, 'GRAPHICS', 'Ignore GPU blocklist', 'Allow GPU acceleration on drivers Chromium blocklists (eDEX-UI default; common on Linux).', { restart: true, advanced: true }),
  e('graphics.ozone_platform', 'auto', [['auto', 'Automatic'], ['wayland', 'Wayland'], ['x11', 'X11 / XWayland']], 'GRAPHICS', 'Linux display backend', 'Select the Ozone platform on Linux. Automatic follows XDG_SESSION_TYPE.', { restart: true, platforms: ['linux'] }),

  // ───────────────────────── visualization ─────────────────────────
  s('visualization.default_animation', 'neural-sphere', 'ANIMATIONS', 'Default animation', 'Preset used for newly added visualization modules.', { options: 'presets', pattern: ID }),
  e('visualization.quality', 'auto', [['auto', 'From performance profile'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], 'ANIMATIONS', 'Visual quality', 'Geometric complexity (node, particle and segment counts) of visualizations.'),
  n('visualization.rotation_speed', 1, 0, 4, 'ANIMATIONS', 'Auto-rotation speed', 'Global multiplier for automatic camera orbiting.', { step: 0.05 }),
  n('visualization.time_scale', 1, 0, 4, 'ANIMATIONS', 'Animation speed', 'Global multiplier for simulation time in all visualizations.', { step: 0.05 }),
  b('visualization.glow', true, 'ANIMATIONS', 'Glow (bloom)', 'Hardware-accelerated bloom post-processing.'),
  n('visualization.glow_strength', 1, 0, 3, 'ANIMATIONS', 'Glow strength', 'Global multiplier on bloom intensity.', { step: 0.05 }),
  b('visualization.motion_blur', false, 'ANIMATIONS', 'Motion blur', 'Temporal accumulation (after-image) motion blur.'),
  n('visualization.motion_blur_amount', 0.75, 0, 0.98, 'ANIMATIONS', 'Motion blur amount', 'How long previous frames persist.'),
  b('visualization.hud', true, 'ANIMATIONS', 'Scientific HUD', 'Overlay labels, statistics and callouts on visualizations.'),
  n('visualization.seed', 1337, 0, 2147483647, 'ANIMATIONS', 'Default seed', 'Seed given to newly added visualizations (each module keeps its own seed).', { int: true, advanced: true }),

  // ───────────────────────── terminal ─────────────────────────
  s('terminal.default_shell', 'auto', 'TERMINAL', 'Shell', '"auto" uses $SHELL (or PowerShell on Windows). Otherwise a shell name on PATH or an absolute path.', { options: 'shells' }),
  { key: 'terminal.shell_args', type: { kind: 'string-list', maxItems: 32 }, default: [], label: 'Shell arguments', description: 'Extra arguments passed to the shell.', category: 'TERMINAL', advanced: true },
  b('terminal.login_shell', true, 'TERMINAL', 'Login shell', 'Start POSIX shells as login shells (-l) so your profile is loaded.', { platforms: ['linux', 'darwin'] }),
  s('terminal.cwd', '', 'TERMINAL', 'Start directory', 'Working directory for new terminals. Empty = home directory.', { placeholder: '~' }),
  s('terminal.font_family', '', 'TERMINAL', 'Font family', 'Terminal font. Empty = the theme monospace font.', { maxLength: 128 }),
  n('terminal.font_size', 13, 6, 40, 'TERMINAL', 'Font size', 'Terminal font size.', { int: true, unit: 'px' }),
  n('terminal.line_height', 1.1, 1, 2, 'TERMINAL', 'Line height', 'Terminal line height multiplier.', { step: 0.05 }),
  n('terminal.letter_spacing', 0, -2, 6, 'TERMINAL', 'Letter spacing', 'Extra pixels between characters.', { step: 0.5, unit: 'px' }),
  e('terminal.cursor_style', 'block', [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']], 'TERMINAL', 'Cursor style', 'Shape of the terminal cursor.'),
  b('terminal.cursor_blink', true, 'TERMINAL', 'Cursor blink', 'Blink the terminal cursor.'),
  n('terminal.scrollback', 5000, 100, 100000, 'TERMINAL', 'Scrollback', 'Lines of history kept per terminal.', { int: true, unit: 'lines' }),
  e('terminal.renderer', 'dom', [['dom', 'DOM (most compatible)'], ['webgl', 'WebGL (fastest)']], 'TERMINAL', 'Renderer', 'WebGL is faster for heavy output but uses one GPU context per terminal.'),
  n('terminal.opacity', 1, 0, 1, 'TERMINAL', 'Background opacity', 'Terminal background opacity; lower values reveal visualizations behind floating terminals.'),
  b('terminal.copy_on_select', false, 'TERMINAL', 'Copy on select', 'Copy selected text to the clipboard automatically.'),
  b('terminal.right_click_paste', false, 'TERMINAL', 'Right-click paste', 'Paste the clipboard on right click.'),
  e('terminal.bell', 'visual', [['none', 'None'], ['visual', 'Flash'], ['sound', 'Sound']], 'TERMINAL', 'Bell', 'What happens when a program rings the terminal bell.'),
  e('terminal.tab_title', 'process', [['process', 'Running process'], ['cwd', 'Working directory'], ['shell', 'Shell name']], 'TERMINAL', 'Tab titles', 'What terminal tabs display.'),
  b('terminal.app_commands', true, 'TERMINAL', 'In-terminal "synapse" command', 'Expose the `synapse` command inside SYNAPSE-UI terminals to control the app (authenticated per session, no network socket).'),
  { key: 'terminal.env', type: { kind: 'string-map', maxItems: 64 }, default: {}, label: 'Environment', description: 'Extra environment variables for shells.', category: 'TERMINAL', advanced: true },

  // ───────────────────────── monitoring ─────────────────────────
  b('monitoring.enabled', true, 'MONITORING', 'System monitoring', 'Poll system statistics. When disabled, monitoring modules show no data.'),
  n('monitoring.interval_scale', 1, 0.25, 4, 'MONITORING', 'Polling interval scale', 'Multiplier for every polling interval (higher = less CPU, slower updates).', { step: 0.05 }),
  e('monitoring.temperature_unit', 'c', [['c', 'Celsius'], ['f', 'Fahrenheit']], 'MONITORING', 'Temperature unit', 'Unit for CPU and GPU temperatures.'),
  s('monitoring.network_interface', 'auto', 'MONITORING', 'Network interface', '"auto" uses the default interface; or an interface name such as wlan0.', { options: 'net_ifaces', maxLength: 64 }),
  n('monitoring.process_limit', 40, 5, 500, 'MONITORING', 'Process rows', 'Maximum processes sent to the process monitor (sorted by the active column).', { int: true }),
  b('monitoring.clock_24h', true, 'MONITORING', '24-hour clock', 'Use a 24-hour clock in the clock module.'),
  b('monitoring.gpu', true, 'MONITORING', 'GPU polling', 'Poll GPU statistics (spawns nvidia-smi on NVIDIA systems).'),

  // ───────────────────────── filesystem & keyboard ─────────────────────────
  b('filesystem.show_hidden', false, 'MONITORING', 'Show hidden files', 'Show dotfiles in the filesystem browser.'),
  b('filesystem.list_view', false, 'MONITORING', 'List view', 'Use a detailed list instead of the eDEX icon grid.'),
  b('filesystem.follow_terminal', true, 'MONITORING', 'Follow terminal', 'Filesystem browser follows the working directory of the focused terminal.'),
  s('keyboard.layout', 'en-US', 'GENERAL', 'On-screen keyboard layout', 'Layout used by the on-screen keyboard module.', { options: 'kb_layouts', pattern: /^[A-Za-z]{2}-[A-Za-z0-9-]{1,16}$/ }),
  b('keyboard.show_physical', true, 'GENERAL', 'Mirror physical keys', 'Highlight on-screen keys when you press them on your physical keyboard.'),

  // ───────────────────────── audio ─────────────────────────
  b('audio.ui_sounds', true, 'AUDIO', 'Interface sounds', 'Play the eDEX-UI interface sound effects.'),
  n('audio.volume', 0.6, 0, 1, 'AUDIO', 'Volume', 'Volume of interface sounds.'),
  b('audio.feedback_sounds', false, 'AUDIO', 'Typing feedback', 'Play sounds for keystrokes and terminal output.'),
  e('audio.input_source', 'none', [['none', 'Off'], ['file', 'Audio file'], ['microphone', 'Microphone / input device'], ['system', 'System audio']], 'AUDIO', 'Reactive audio source', 'Source analysed for audio-reactive visualizations. Microphone and system audio require explicit permission each session.'),
  s('audio.input_device', 'default', 'AUDIO', 'Input device', 'Input device id for microphone capture (on Linux, PipeWire/PulseAudio "Monitor of …" devices capture system output).', { options: 'audio_devices', maxLength: 256 }),
  s('audio.file', '', 'AUDIO', 'Audio file', 'Last audio file used as the reactive source.', { maxLength: 4096, advanced: true }),
  n('audio.gain', 1, 0, 8, 'AUDIO', 'Analysis gain', 'Amplification applied before frequency analysis.', { step: 0.1 }),
  n('audio.smoothing', 0.8, 0, 0.99, 'AUDIO', 'Smoothing', 'Temporal smoothing of the frequency spectrum.'),
  n('audio.beat_sensitivity', 1.35, 1.05, 3, 'AUDIO', 'Beat sensitivity', 'Energy ratio over the running average that counts as a beat (lower = more beats).'),
  b('audio.monitor_file', true, 'AUDIO', 'Play file audio', 'Play audio files through the speakers while analysing them.'),

  // ───────────────────────── recording ─────────────────────────
  s('recording.output_dir', '', 'ANIMATIONS', 'Recording folder', 'Where screenshots and recordings are saved. Empty = Videos/SYNAPSE-UI (or Pictures for images).', { maxLength: 4096 }),
  e('recording.format', 'webm', [['webm', 'WebM video (real-time)'], ['png', 'PNG screenshot'], ['png-sequence', 'PNG image sequence (offline)'], ['gif', 'Animated GIF (offline)'], ['mp4', 'MP4 via ffmpeg (offline)']], 'ANIMATIONS', 'Recording format', 'Output format used by the record command.'),
  n('recording.width', 0, 0, 7680, 'ANIMATIONS', 'Recording width', 'Output width in pixels for offline formats (0 = module size).', { int: true, unit: 'px' }),
  n('recording.height', 0, 0, 4320, 'ANIMATIONS', 'Recording height', 'Output height in pixels for offline formats (0 = module size).', { int: true, unit: 'px' }),
  n('recording.fps', 30, 1, 120, 'ANIMATIONS', 'Recording frame rate', 'Frames per second for recordings.', { int: true, unit: 'fps' }),
  n('recording.duration', 10, 1, 600, 'ANIMATIONS', 'Recording duration', 'Length of recordings.', { step: 1, unit: 's' }),
  n('recording.quality', 0.9, 0.1, 1, 'ANIMATIONS', 'Recording quality', 'Bit-rate (WebM/MP4) or palette quality (GIF).'),

  // ───────────────────────── security ─────────────────────────
  b('security.allow_extension_scripts', false, 'MODULES', 'Allow extension scripts', 'Allow third-party modules that declare the "script" permission to run JavaScript (each still needs individual approval). Declarative modules never need this.'),
  e('security.external_links', 'ask', [['ask', 'Ask every time'], ['allow', 'Open in browser'], ['deny', 'Never open']], 'ADVANCED', 'External links', 'What happens when you click a URL in a terminal.'),
  b('security.devtools', false, 'ADVANCED', 'Developer tools', 'Allow opening Chromium developer tools (Ctrl+Shift+I).', { advanced: true }),

  // ───────────────────────── advanced ─────────────────────────
  e('advanced.log_level', 'info', [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['debug', 'Debug']], 'ADVANCED', 'Log level', 'Verbosity of the main-process log.'),
  b('advanced.watch_config', true, 'ADVANCED', 'Live-reload config files', 'Watch the configuration directory and apply external edits immediately.'),
  n('advanced.backup_count', 20, 1, 200, 'ADVANCED', 'Backups kept', 'Number of automatic configuration backups to keep.', { int: true }),

  // ───────────────────────── global color overrides ─────────────────────────
  c('colors.background', 'APPEARANCE', 'Background override', 'Overrides the active theme background for every workspace. Empty = theme value.'),
  c('colors.foreground', 'APPEARANCE', 'Foreground override', 'Overrides the theme foreground (lines, graph strokes).'),
  c('colors.text', 'APPEARANCE', 'Text override', 'Overrides the theme text color.'),
  c('colors.accent', 'APPEARANCE', 'Accent override', 'Overrides the theme accent color.'),
  c('colors.border', 'APPEARANCE', 'Border override', 'Overrides the theme border color.'),
  c('colors.glow', 'APPEARANCE', 'Glow override', 'Overrides the theme glow color.'),
  c('colors.highlight', 'APPEARANCE', 'Highlight override', 'Overrides the theme highlight color.'),
  c('colors.neural', 'APPEARANCE', 'Neural connection override', 'Overrides neural connection color in visualizations.'),
  c('colors.particle', 'APPEARANCE', 'Particle override', 'Overrides particle color in visualizations.'),
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((d) => [d.key, d]));

export type Config = Record<string, SettingValue>;

export interface ConfigIssue {
  key: string;
  message: string;
  severity: 'error' | 'warning';
}

export function defaultConfig(): Config {
  const out: Config = {};
  for (const def of SETTINGS) out[def.key] = cloneValue(def.default);
  return out;
}

function cloneValue(v: SettingValue): SettingValue {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') return { ...v };
  return v;
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
export function isColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_RE.test(value.trim());
}

/** Validate a single value against its definition. Returns the coerced value or an error string. */
export function validateSetting(def: SettingDef, value: unknown): { ok: true; value: SettingValue } | { ok: false; error: string } {
  const t = def.type;
  switch (t.kind) {
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'expected true or false' };
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'expected a number' };
      if (t.int && !Number.isInteger(value)) return { ok: false, error: 'expected an integer' };
      if (value < t.min || value > t.max) return { ok: false, error: `must be between ${t.min} and ${t.max}` };
      return { ok: true, value };
    }
    case 'enum':
      return typeof value === 'string' && t.options.some((o) => o.value === value)
        ? { ok: true, value }
        : { ok: false, error: `expected one of ${t.options.map((o) => JSON.stringify(o.value)).join(', ')}` };
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: 'expected a string' };
      if (t.maxLength !== undefined && value.length > t.maxLength) return { ok: false, error: `longer than ${t.maxLength} characters` };
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) return { ok: false, error: 'contains control characters' };
      if (t.pattern && !t.pattern.test(value)) return { ok: false, error: `does not match ${t.pattern}` };
      return { ok: true, value };
    }
    case 'color':
      if (value === '' && t.optional) return { ok: true, value: '' };
      return isColor(value) ? { ok: true, value: value.trim() } : { ok: false, error: 'expected a color like "#rrggbb" or "rgba(r,g,b,a)"' };
    case 'string-list': {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) return { ok: false, error: 'expected an array of strings' };
      if (t.maxItems !== undefined && value.length > t.maxItems) return { ok: false, error: `more than ${t.maxItems} items` };
      if (value.some((x) => x.length > 4096 || x.includes('\u0000'))) return { ok: false, error: 'item too long or contains NUL' };
      return { ok: true, value: [...value] };
    }
    case 'string-map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'expected a table of strings' };
      const entries = Object.entries(value as Record<string, unknown>);
      if (t.maxItems !== undefined && entries.length > t.maxItems) return { ok: false, error: `more than ${t.maxItems} entries` };
      const out: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) return { ok: false, error: `invalid key "${k}"` };
        if (typeof v !== 'string' || v.length > 4096 || v.includes('\u0000')) return { ok: false, error: `value of "${k}" must be a string` };
        out[k] = v;
      }
      return { ok: true, value: out };
    }
  }
}

/** Flatten a parsed TOML object ({application:{theme:"x"}}) into dotted keys. */
export function flattenSections(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [section, body] of Object.entries(raw)) {
    if (section === 'config_version') continue;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) out[`${section}.${k}`] = v;
    } else {
      out[section] = body;
    }
  }
  return out;
}

/**
 * Validate a raw parsed configuration. Never throws: each invalid field falls
 * back to its default and is reported, so one typo never breaks startup.
 */
export function validateConfig(raw: unknown): { config: Config; issues: ConfigIssue[] } {
  const config = defaultConfig();
  const issues: ConfigIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ key: '', message: 'configuration root must be a table', severity: 'error' });
    return { config, issues };
  }
  const flat = flattenSections(raw as Record<string, unknown>);
  for (const [key, value] of Object.entries(flat)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      issues.push({ key, message: 'unknown setting (ignored)', severity: 'warning' });
      continue;
    }
    const r = validateSetting(def, value);
    if (r.ok) config[key] = r.value;
    else issues.push({ key, message: `${r.error}; using default ${JSON.stringify(def.default)}`, severity: 'error' });
  }
  return { config, issues };
}

/** Apply a patch of dotted keys. Rejects the whole patch if any value is invalid. */
export function applyPatch(current: Config, patch: Record<string, unknown>): { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const next: Config = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      issues.push({ key, message: 'unknown setting', severity: 'error' });
      continue;
    }
    const r = value === null ? { ok: true as const, value: cloneValue(def.default) } : validateSetting(def, value);
    if (r.ok) next[key] = r.value;
    else issues.push({ key, message: r.error, severity: 'error' });
  }
  return issues.length ? { ok: false, issues } : { ok: true, config: next };
}

export function diffConfig(a: Config, b: Config): string[] {
  const changed: string[] = [];
  for (const def of SETTINGS) if (JSON.stringify(a[def.key]) !== JSON.stringify(b[def.key])) changed.push(def.key);
  return changed;
}

/** Emit the full configuration as a commented, human-readable TOML document. */
export function emitConfigToml(config: Config): string {
  const lines: string[] = [
    '# SYNAPSE-UI configuration',
    '#',
    '# This file is regenerated when settings change in the graphical interface;',
    '# comments you add here will not be preserved (descriptions are regenerated).',
    '# Edits made while SYNAPSE-UI is running are validated and applied live.',
    '# Invalid values fall back to their defaults and are reported in the app.',
    '# Full reference: docs/CONFIGURATION.md',
    '',
    `config_version = ${CONFIG_VERSION}`,
  ];
  let section = '';
  for (const def of SETTINGS) {
    const [sec, name] = splitKey(def.key);
    if (sec !== section) {
      section = sec;
      lines.push('', `[${sec}]`);
    }
    const meta: string[] = [];
    if (def.type.kind === 'enum') meta.push('one of: ' + def.type.options.map((o) => o.value).join(' | '));
    if (def.type.kind === 'number') meta.push(`range ${def.type.min}…${def.type.max}${def.type.unit ? ' ' + def.type.unit : ''}`);
    if (def.restart) meta.push('requires restart');
    lines.push(...tomlComment(def.description + (meta.length ? ` (${meta.join('; ')})` : '')));
    const value = config[def.key];
    if (def.type.kind === 'color' && value === '') {
      lines.push(`# ${tomlKey(name)} = "#000000"`);
    } else {
      lines.push(`${tomlKey(name)} = ${tomlValue(value as TomlValue)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function splitKey(key: string): [string, string] {
  const i = key.indexOf('.');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Convert flat config back into nested sections (for exporting as JSON). */
export function nestConfig(config: Config): Record<string, Record<string, SettingValue>> {
  const out: Record<string, Record<string, SettingValue>> = {};
  for (const [key, value] of Object.entries(config)) {
    const [sec, name] = splitKey(key);
    (out[sec] ??= {})[name] = value;
  }
  return out;
}

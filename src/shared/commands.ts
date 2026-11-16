/**
 * Grammar of `synapse …` application commands. The same grammar is accepted
 * by the command palette and by the in-terminal `synapse` helper. Commands
 * only ever invoke application actions — never shell execution.
 */

export const CAMERA_MODES = ['orbital', 'microscopic', 'cinematic', 'interactive', 'tracking', 'macro'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const PERFORMANCE_MODES = ['eco', 'balanced', 'high', 'cinematic', 'adaptive'] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];

export type ArgKind = 'preset' | 'workspace' | 'theme' | 'camera' | 'perf' | 'setting' | 'module-type' | 'word' | 'rest' | 'onoff' | 'format';

export interface CommandSpec {
  path: string[];
  args: { name: string; kind: ArgKind; optional?: boolean }[];
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { path: ['help'], args: [{ name: 'topic', kind: 'word', optional: true }], description: 'List commands' },
  { path: ['version'], args: [], description: 'Show SYNAPSE-UI, Electron and Chromium versions' },
  { path: ['animation', 'load'], args: [{ name: 'preset', kind: 'preset' }], description: 'Load an animation preset into the focused (or first) visualization' },
  { path: ['animation', 'list'], args: [], description: 'List animation presets' },
  { path: ['animation', 'pause'], args: [], description: 'Pause all visualizations' },
  { path: ['animation', 'resume'], args: [], description: 'Resume all visualizations' },
  { path: ['animation', 'restart'], args: [], description: 'Restart the focused visualization from t=0' },
  { path: ['animation', 'set'], args: [{ name: 'param', kind: 'word' }, { name: 'value', kind: 'rest' }], description: 'Set a parameter (number, color, true/false or =expression) on the focused visualization' },
  { path: ['animation', 'seed'], args: [{ name: 'seed', kind: 'word' }], description: 'Regenerate the focused visualization with a new seed' },
  { path: ['animation', 'editor'], args: [], description: 'Open the animation editor' },
  { path: ['camera'], args: [{ name: 'mode', kind: 'camera' }], description: 'Set the camera mode of the focused visualization (orbit = orbital)' },
  { path: ['workspace', 'switch'], args: [{ name: 'workspace', kind: 'workspace' }], description: 'Switch workspace profile' },
  { path: ['workspace', 'list'], args: [], description: 'List workspace profiles' },
  { path: ['workspace', 'save'], args: [{ name: 'name', kind: 'rest', optional: true }], description: 'Save the current layout (optionally as a new profile)' },
  { path: ['workspace', 'edit'], args: [], description: 'Toggle the workspace editor' },
  { path: ['workspace', 'mode'], args: [{ name: 'mode', kind: 'word' }], description: 'Set layout mode: grid | freeform | hybrid' },
  { path: ['module', 'add'], args: [{ name: 'type', kind: 'module-type' }, { name: 'preset', kind: 'preset', optional: true }], description: 'Add a module to the current workspace' },
  { path: ['module', 'list'], args: [], description: 'List available module types' },
  { path: ['theme', 'set'], args: [{ name: 'theme', kind: 'theme' }], description: 'Switch theme' },
  { path: ['theme', 'list'], args: [], description: 'List themes' },
  { path: ['theme', 'editor'], args: [], description: 'Open the theme editor' },
  { path: ['performance'], args: [{ name: 'mode', kind: 'perf' }], description: 'Set the performance profile' },
  { path: ['config', 'get'], args: [{ name: 'key', kind: 'setting' }], description: 'Print a setting' },
  { path: ['config', 'set'], args: [{ name: 'key', kind: 'setting' }, { name: 'value', kind: 'rest' }], description: 'Change a setting (value parsed as TOML)' },
  { path: ['config', 'reset'], args: [{ name: 'key', kind: 'setting' }], description: 'Reset a setting to its default' },
  { path: ['settings'], args: [{ name: 'category', kind: 'rest', optional: true }], description: 'Open the settings interface' },
  { path: ['fullscreen'], args: [{ name: 'state', kind: 'onoff', optional: true }], description: 'Toggle or set fullscreen' },
  { path: ['screenshot'], args: [], description: 'Save a PNG of the focused visualization' },
  { path: ['record'], args: [{ name: 'format', kind: 'format', optional: true }], description: 'Record the focused visualization (webm | gif | png-sequence | mp4)' },
  { path: ['diagnostics'], args: [], description: 'Toggle the rendering diagnostics overlay' },
  { path: ['setup'], args: [], description: 'Open the first-run setup again' },
];

export interface ParsedCommand {
  spec: CommandSpec;
  args: Record<string, string>;
}

/** Split a command line into words, honouring single/double quotes. */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

const ALIASES: Record<string, string[]> = {
  orbit: ['orbital'],
  'signal-tracking': ['tracking'],
  signal: ['tracking'],
  track: ['tracking'],
  micro: ['microscopic'],
};

export function parseCommand(input: string[] | string): { ok: true; cmd: ParsedCommand } | { ok: false; error: string } {
  let words = typeof input === 'string' ? splitWords(input) : [...input];
  if (words[0] === 'synapse') words = words.slice(1);
  if (words.length === 0) return { ok: false, error: 'no command given — try `synapse help`' };
  if (words.length > 64 || words.some((w) => w.length > 512)) return { ok: false, error: 'command too long' };
  let best: CommandSpec | null = null;
  for (const spec of COMMANDS) {
    if (spec.path.every((p, i) => words[i] === p) && (!best || spec.path.length > best.path.length)) best = spec;
  }
  if (!best) {
    const head = words[0];
    const similar = COMMANDS.filter((c) => c.path[0] === head).map((c) => c.path.join(' '));
    return { ok: false, error: similar.length ? `unknown subcommand; did you mean: ${similar.join(', ')}` : `unknown command "${head}" — try \`synapse help\`` };
  }
  const rest = words.slice(best.path.length);
  const args: Record<string, string> = {};
  for (let i = 0; i < best.args.length; i++) {
    const a = best.args[i];
    if (a.kind === 'rest') {
      const v = rest.slice(i).join(' ');
      if (!v && !a.optional) return { ok: false, error: `missing <${a.name}>. usage: ${usage(best)}` };
      if (v) args[a.name] = v;
      break;
    }
    let v = rest[i];
    if (v === undefined) {
      if (a.optional) continue;
      return { ok: false, error: `missing <${a.name}>. usage: ${usage(best)}` };
    }
    if (a.kind === 'camera') {
      v = ALIASES[v]?.[0] ?? v;
      if (!(CAMERA_MODES as readonly string[]).includes(v)) return { ok: false, error: `unknown camera mode "${v}" (${CAMERA_MODES.join(', ')}, orbit)` };
    }
    if (a.kind === 'perf' && !(PERFORMANCE_MODES as readonly string[]).includes(v)) return { ok: false, error: `unknown performance mode "${v}" (${PERFORMANCE_MODES.join(', ')})` };
    if (a.kind === 'onoff' && !['on', 'off', 'toggle'].includes(v)) return { ok: false, error: 'expected on | off | toggle' };
    if (a.kind === 'format' && !['webm', 'gif', 'png', 'png-sequence', 'mp4'].includes(v)) return { ok: false, error: 'expected webm | gif | png | png-sequence | mp4' };
    args[a.name] = v;
  }
  if (!best.args.some((a) => a.kind === 'rest') && rest.length > best.args.length) return { ok: false, error: `too many arguments. usage: ${usage(best)}` };
  return { ok: true, cmd: { spec: best, args } };
}

export function usage(spec: CommandSpec): string {
  return ['synapse', ...spec.path, ...spec.args.map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`))].join(' ');
}

export function helpText(): string {
  const w = Math.max(...COMMANDS.map((c) => usage(c).length));
  return COMMANDS.map((c) => `  ${usage(c).padEnd(w)}  ${c.description}`).join('\n');
}

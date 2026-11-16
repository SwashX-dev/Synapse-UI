/**
 * Application keybindings. Stored in keybindings.toml as
 *   [bindings]
 *   "workspace.editor" = "Ctrl+Shift+E"
 * An empty string disables an action.
 */

export interface ActionDef { id: string; label: string; default: string; category: string }

export const ACTIONS: ActionDef[] = [
  { id: 'palette.open', label: 'Command palette', default: 'Ctrl+Shift+P', category: 'General' },
  { id: 'settings.open', label: 'Open settings', default: 'Ctrl+Shift+S', category: 'General' },
  { id: 'workspace.editor', label: 'Toggle workspace editor', default: 'Ctrl+Shift+E', category: 'Workspace' },
  { id: 'workspace.next', label: 'Next workspace', default: 'Ctrl+Alt+PageDown', category: 'Workspace' },
  { id: 'workspace.prev', label: 'Previous workspace', default: 'Ctrl+Alt+PageUp', category: 'Workspace' },
  { id: 'workspace.save', label: 'Save workspace', default: 'Ctrl+Shift+W', category: 'Workspace' },
  { id: 'editor.undo', label: 'Undo layout change', default: 'Ctrl+Z', category: 'Workspace' },
  { id: 'editor.redo', label: 'Redo layout change', default: 'Ctrl+Shift+Z', category: 'Workspace' },
  { id: 'editor.duplicate', label: 'Duplicate selected modules', default: 'Ctrl+D', category: 'Workspace' },
  { id: 'editor.delete', label: 'Remove selected modules', default: 'Delete', category: 'Workspace' },
  { id: 'theme.editor', label: 'Theme editor', default: 'Ctrl+Shift+T', category: 'Appearance' },
  { id: 'animation.editor', label: 'Animation editor', default: 'Ctrl+Shift+A', category: 'Visualization' },
  { id: 'animation.toggle', label: 'Pause / resume visualizations', default: 'Ctrl+Shift+Space', category: 'Visualization' },
  { id: 'camera.cycle', label: 'Cycle camera mode', default: 'Ctrl+Shift+G', category: 'Visualization' },
  { id: 'capture.screenshot', label: 'Screenshot focused visualization', default: 'Ctrl+Shift+F12', category: 'Visualization' },
  { id: 'capture.record', label: 'Start / stop recording', default: 'Ctrl+Shift+R', category: 'Visualization' },
  { id: 'diagnostics.toggle', label: 'Rendering diagnostics', default: 'Ctrl+Shift+D', category: 'Visualization' },
  { id: 'modules.manager', label: 'Module manager', default: 'Ctrl+Shift+M', category: 'General' },
  { id: 'terminal.newTab', label: 'New terminal tab', default: 'Ctrl+Shift+N', category: 'Terminal' },
  { id: 'terminal.closeTab', label: 'Close terminal tab', default: 'Ctrl+Shift+Q', category: 'Terminal' },
  { id: 'terminal.nextTab', label: 'Next terminal tab', default: 'Ctrl+Tab', category: 'Terminal' },
  { id: 'terminal.prevTab', label: 'Previous terminal tab', default: 'Ctrl+Shift+Tab', category: 'Terminal' },
  { id: 'terminal.splitH', label: 'Split terminal horizontally', default: 'Ctrl+Shift+H', category: 'Terminal' },
  { id: 'terminal.splitV', label: 'Split terminal vertically', default: 'Ctrl+Shift+J', category: 'Terminal' },
  { id: 'terminal.copy', label: 'Copy', default: 'Ctrl+Shift+C', category: 'Terminal' },
  { id: 'terminal.paste', label: 'Paste', default: 'Ctrl+Shift+V', category: 'Terminal' },
  { id: 'terminal.search', label: 'Search terminal', default: 'Ctrl+Shift+F', category: 'Terminal' },
  { id: 'terminal.focusNext', label: 'Focus next terminal pane', default: 'Ctrl+Shift+O', category: 'Terminal' },
  { id: 'terminal.fontUp', label: 'Increase terminal font', default: 'Ctrl+=', category: 'Terminal' },
  { id: 'terminal.fontDown', label: 'Decrease terminal font', default: 'Ctrl+-', category: 'Terminal' },
  { id: 'app.fullscreen', label: 'Toggle fullscreen', default: 'F11', category: 'General' },
  { id: 'app.devtools', label: 'Developer tools', default: 'Ctrl+Shift+I', category: 'General' },
  { id: 'app.reload', label: 'Reload interface', default: 'Ctrl+Shift+F5', category: 'General' },
  { id: 'app.quit', label: 'Quit', default: 'Ctrl+Shift+Alt+Q', category: 'General' },
];

export const ACTION_IDS = new Set(ACTIONS.map((a) => a.id));

export function defaultBindings(): Record<string, string> {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, a.default]));
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', Plus: '=', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Control: 'Ctrl', Cmd: 'Meta', Command: 'Meta', Super: 'Meta', Option: 'Alt',
};

/** Normalise an accelerator: modifier order Ctrl+Alt+Shift+Meta, then the key. Returns null if invalid. */
export function normalizeAccelerator(acc: string): string | null {
  if (acc === '') return '';
  if (acc.length > 64) return null;
  const parts = acc.split('+').map((p) => p.trim());
  // Support "Ctrl++" style.
  if (acc.endsWith('++')) { parts.splice(parts.length - 2, 2, '='); }
  const mods = new Set<string>();
  let key = '';
  for (const raw of parts) {
    if (!raw) return null;
    const p = KEY_ALIASES[raw] ?? raw;
    const m = MODS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (m) { mods.add(m); continue; }
    if (key) return null;
    key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }
  if (!key) return null;
  if (!/^([A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|[-=[\];',./`\\])$/.test(key)) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

/** Accelerator string for a DOM KeyboardEvent (uses physical `code` for letters/digits). */
export function eventToAccelerator(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Semicolon') key = ';';
  else if (e.code === 'Quote') key = "'";
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Backquote') key = '`';
  else if (e.code === 'Backslash') key = '\\';
  else if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  else key = KEY_ALIASES[e.key] ?? e.key;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean) as string[];
  return normalizeAccelerator([...mods, key].join('+'));
}

export function validateBindings(raw: unknown): { bindings: Record<string, string>; issues: string[] } {
  const bindings = defaultBindings();
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') return { bindings, issues };
  for (const [id, acc] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id)) { issues.push(`unknown action "${id}"`); continue; }
    if (typeof acc !== 'string') { issues.push(`${id}: expected a string`); continue; }
    const norm = normalizeAccelerator(acc);
    if (norm === null) { issues.push(`${id}: invalid accelerator "${acc}"`); continue; }
    bindings[id] = norm;
  }
  // Report conflicts (both keep working; the first registered wins).
  const seen = new Map<string, string>();
  for (const [id, acc] of Object.entries(bindings)) {
    if (!acc) continue;
    const other = seen.get(acc);
    if (other) issues.push(`"${acc}" is bound to both ${other} and ${id}`);
    else seen.set(acc, id);
  }
  return { bindings, issues };
}

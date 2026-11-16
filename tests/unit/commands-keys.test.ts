import { describe, expect, it } from 'vitest';
import { parseCommand, splitWords, helpText } from '../../src/shared/commands';
import { eventToAccelerator, normalizeAccelerator, validateBindings } from '../../src/shared/keybindings';

describe('synapse command grammar', () => {
  it('parses the documented examples', () => {
    for (const line of ['synapse animation load neural-sphere', 'synapse animation pause', 'synapse animation resume', 'synapse workspace switch neural-lab', 'synapse theme set obsidian', 'synapse camera orbit', 'synapse performance balanced']) {
      expect(parseCommand(line).ok, line).toBe(true);
    }
    const cam = parseCommand('camera orbit');
    expect(cam.ok && cam.cmd.args.mode).toBe('orbital');
    const set = parseCommand(['animation', 'set', 'rate', '=', '0.5', '*', 'sin(t)']);
    expect(set.ok && set.cmd.args.value).toBe('= 0.5 * sin(t)');
  });

  it('reports helpful errors', () => {
    const bad = parseCommand('synapse camera sideways');
    expect(!bad.ok && bad.error).toMatch(/unknown camera mode/);
    expect(parseCommand('synapse frobnicate').ok).toBe(false);
    expect(parseCommand('synapse theme set').ok).toBe(false);
    expect(parseCommand('synapse performance turbo').ok).toBe(false);
    expect(parseCommand('synapse version extra').ok).toBe(false);
    expect(helpText()).toContain('synapse animation load <preset>');
  });

  it('splits quoted words', () => {
    expect(splitWords(`workspace save "My Lab" 'x y'`)).toEqual(['workspace', 'save', 'My Lab', 'x y']);
  });
});

describe('keybindings', () => {
  it('normalises accelerators', () => {
    expect(normalizeAccelerator('shift+ctrl+e')).toBe('Ctrl+Shift+E');
    expect(normalizeAccelerator('Cmd+Option+K')).toBe('Alt+Meta+K');
    expect(normalizeAccelerator('Ctrl+Shift')).toBeNull();
    expect(normalizeAccelerator('Ctrl+NotAKey')).toBeNull();
    expect(normalizeAccelerator('')).toBe('');
  });
  it('maps DOM events by physical key', () => {
    expect(eventToAccelerator({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe('Ctrl+Shift+E');
    expect(eventToAccelerator({ key: 'Shift', code: 'ShiftLeft', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false })).toBeNull();
    expect(eventToAccelerator({ key: 'F11', code: 'F11', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toBe('F11');
  });
  it('validates binding files and flags conflicts', () => {
    const r = validateBindings({ 'workspace.editor': 'Ctrl+Shift+P', 'no.such.action': 'F1', 'settings.open': 42 });
    expect(r.bindings['workspace.editor']).toBe('Ctrl+Shift+P');
    expect(r.issues.some((i) => i.includes('unknown action'))).toBe(true);
    expect(r.issues.some((i) => i.includes('bound to both'))).toBe(true);
    expect(r.issues.some((i) => i.includes('settings.open'))).toBe(true);
  });
});

/** Keyboard shortcut dispatch driven by keybindings.toml. */
import type { App } from './app';
import { eventToAccelerator } from '../../shared/keybindings';

const EDITOR_SCOPED = new Set(['editor.undo', 'editor.redo', 'editor.duplicate', 'editor.delete']);

export class Keybindings {
  private byAccel = new Map<string, string>();
  private handlers = new Map<string, () => void>();
  editorActive = () => false;
  /** Capturing mode for the keybinding editor (receives accelerators instead of dispatch). */
  capture: ((accel: string) => void) | null = null;

  constructor(private app: App) {
    this.reload();
    app.events.on('bindings', () => void this.refetch());
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  private async refetch(): Promise<void> {
    const r = await window.synapse.config.keybindings();
    this.app.snapshot = { ...this.app.snapshot, bindings: r.bindings, bindingIssues: r.issues };
    this.reload();
  }

  reload(): void {
    this.byAccel.clear();
    for (const [action, accel] of Object.entries(this.app.snapshot.bindings)) if (accel && !this.byAccel.has(accel)) this.byAccel.set(accel, action);
  }

  register(action: string, fn: () => void): void {
    this.handlers.set(action, fn);
  }

  accelFor(action: string): string {
    return this.app.snapshot.bindings[action] ?? '';
  }

  private onKey(e: KeyboardEvent): void {
    const accel = eventToAccelerator(e);
    if (!accel) return;
    if (this.capture) {
      e.preventDefault();
      e.stopPropagation();
      if (accel !== 'Escape') this.capture(accel);
      else this.capture('');
      return;
    }
    const action = this.byAccel.get(accel);
    if (!action) return;
    const target = e.target as HTMLElement | null;
    const inTerminal = !!target?.closest('.xterm');
    const inInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) && !inTerminal;
    if (EDITOR_SCOPED.has(action)) {
      if (!this.editorActive() || inInput || inTerminal) return;
    } else if (inTerminal || inInput) {
      // Inside terminals/inputs, only pass through chords that do not collide with normal typing/shell keys.
      const safe = /^(Ctrl\+Shift\+|Ctrl\+Alt\+|Ctrl\+Shift\+Alt\+|F\d+$|Ctrl\+Tab|Ctrl\+=|Ctrl\+-)/.test(accel) || /^Shift\+F\d+/.test(accel);
      if (!safe) return;
    }
    const fn = this.handlers.get(action);
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

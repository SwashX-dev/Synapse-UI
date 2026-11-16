/**
 * Overlay manager: toasts, eDEX-style modal windows, confirmation dialogs and
 * entry points for every tool window (settings, palette, editors, managers).
 */
import type { App } from '../core/app';
import { h } from '../core/util';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

export interface Panel {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
  onClose(fn: () => void): void;
}

export class Overlays {
  private root = document.getElementById('overlays')!;
  private toastRoot = document.getElementById('toasts')!;
  private panels = new Map<string, Panel>();
  editorOpen = false;
  diagnosticsOpen = false;
  /** Late-bound tool implementations (registered by main.ts to avoid import cycles). */
  tools: {
    settings?: (category?: string) => void;
    palette?: (initial?: string) => void;
    themeEditor?: () => void;
    animationEditor?: (moduleId?: string) => void;
    moduleManager?: () => void;
    diagnostics?: () => void;
    firstRun?: () => void;
    editor?: () => void;
    moduleSettings?: (moduleId: string) => void;
  } = {};

  constructor(private app: App) {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const top = [...this.panels.values()].at(-1);
      if (top && !(e.target as HTMLElement)?.closest('.xterm')) {
        e.preventDefault();
        top.close();
      }
    });
  }

  toast(message: string, kind: ToastKind = 'info', ms = 4200): void {
    if (!this.app.get<boolean>('interface.notifications') && kind !== 'error') return;
    const el = h('div.toast', { class: kind, role: kind === 'error' ? 'alert' : 'status' }, h('span.k', kind.toUpperCase()), h('span.m', message));
    this.toastRoot.append(el);
    while (this.toastRoot.children.length > 5) this.toastRoot.firstElementChild?.remove();
    if (kind === 'error') this.app.sounds?.play('error');
    else if (kind === 'warn') this.app.sounds?.play('alarm', 0.5);
    else this.app.sounds?.play('info', 0.5);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  /** Open (or focus) a named panel window. */
  panel(id: string, title: string, opts: { width?: string; height?: string; className?: string; subtitle?: string } = {}): Panel {
    const existing = this.panels.get(id);
    if (existing) {
      this.root.append(existing.el);
      return existing;
    }
    const closers: (() => void)[] = [];
    const body = h('div.panel-body');
    const closeBtn = h('button.ghost.panel-close', { 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
    const el = h('div.panel-window', { role: 'dialog', 'aria-label': title, 'data-panel': id, class: opts.className ?? '' },
      h('header.panel-head', h('span.t', title), opts.subtitle ? h('span.s', opts.subtitle) : '', closeBtn),
      body,
    );
    if (opts.width) el.style.width = opts.width;
    if (opts.height) el.style.height = opts.height;
    const backdrop = h('div.panel-backdrop', el);
    const panel: Panel = {
      el: backdrop,
      body,
      close: () => {
        if (!this.panels.has(id)) return;
        this.panels.delete(id);
        backdrop.classList.add('out');
        setTimeout(() => backdrop.remove(), 180);
        for (const c of closers) {
          try { c(); } catch (e) { console.error(e); }
        }
        this.app.sounds?.play('panels', 0.4);
      },
      onClose: (fn) => closers.push(fn),
    };
    closeBtn.addEventListener('click', () => panel.close());
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) panel.close();
    });
    this.root.append(backdrop);
    this.panels.set(id, panel);
    this.app.sounds?.play('expand', 0.5);
    requestAnimationFrame(() => (el.querySelector('input, select, button:not(.panel-close), [tabindex]') as HTMLElement | null)?.focus());
    return panel;
  }

  isOpen(id: string): boolean {
    return this.panels.has(id);
  }

  closePanel(id: string): void {
    this.panels.get(id)?.close();
  }

  confirm(opts: { title: string; message: string; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      const p = this.panel(`confirm-${Date.now()}`, opts.title, { className: 'confirm', width: 'min(460px, 92vw)' });
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        p.close();
        resolve(v);
      };
      const yes = h('button', { class: opts.danger ? 'danger' : 'primary', onclick: () => finish(true) }, opts.confirm ?? 'Confirm');
      const no = h('button', { onclick: () => finish(false) }, opts.cancel ?? 'Cancel');
      p.body.append(h('p.confirm-msg', opts.message), h('div.row.end', no, yes));
      p.onClose(() => finish(false));
      if (opts.danger) this.app.sounds?.play('alarm', 0.6);
      setTimeout(() => (opts.danger ? no : yes).focus(), 30);
    });
  }

  prompt(opts: { title: string; label: string; value?: string; placeholder?: string; validate?: (v: string) => string | null }): Promise<string | null> {
    return new Promise((resolve) => {
      const p = this.panel(`prompt-${Date.now()}`, opts.title, { className: 'confirm', width: 'min(460px, 92vw)' });
      let done = false;
      const input = h('input', { value: opts.value ?? '', placeholder: opts.placeholder ?? '', spellcheck: 'false' });
      const err = h('div.form-error');
      const finish = (v: string | null) => {
        if (done) return;
        if (v !== null && opts.validate) {
          const e = opts.validate(v);
          if (e) { err.textContent = e; return; }
        }
        done = true;
        p.close();
        resolve(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value);
      });
      p.body.append(h('label.field', h('span.label', opts.label), input), err, h('div.row.end', h('button', { onclick: () => finish(null) }, 'Cancel'), h('button.primary', { onclick: () => finish(input.value) }, 'OK')));
      p.onClose(() => finish(null));
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  // ───────── tool entry points ─────────
  openSettings(category?: string): void { this.tools.settings?.(category); }
  openPalette(initial?: string): void { this.tools.palette?.(initial); }
  openThemeEditor(): void { this.tools.themeEditor?.(); }
  openAnimationEditor(moduleId?: string): void { this.tools.animationEditor?.(moduleId); }
  openModuleManager(): void { this.tools.moduleManager?.(); }
  toggleDiagnostics(): void { this.tools.diagnostics?.(); }
  openFirstRun(): void { this.tools.firstRun?.(); }
  toggleEditor(): void { this.tools.editor?.(); }
  openModuleSettings(id: string): void { this.tools.moduleSettings?.(id); }
}

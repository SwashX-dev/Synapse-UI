/**
 * Terminal module: real shells (node-pty in the main process, IPC only),
 * eDEX-style tabs, split panes, search, copy/paste, scrollback, themes,
 * and the authenticated in-terminal `synapse` command bridge (OSC 7701).
 */
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SynModule, registerModuleType, type DisposeReason, type ModuleContext } from '../workspace/module';
import { bridge } from '../core/bridge';
import { debounce, h } from '../core/util';
import type { Theme } from '../../shared/theme';

interface Pane {
  el: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webgl: WebglAddon | null;
  sessionId: string | null;
  token: string;
  shell: string;
  exited: boolean;
  title: string;
  cwd: string | null;
  disposers: (() => void)[];
}

interface Tab { id: number; el: HTMLElement; tabEl: HTMLElement; panes: Pane[]; dir: 'row' | 'column'; focused: number }

const decoder = new TextDecoder();

/** Global registry so other modules (filesystem, keyboard) can find the active terminal. */
export const terminals = { active: null as TerminalModule | null, all: new Set<TerminalModule>() };

export class TerminalModule extends SynModule {
  private tabs: Tab[] = [];
  private active = 0;
  private tabBar = h('ul.term-tabs', { role: 'tablist' });
  private stage = h('div.term-stage');
  private searchBar = h('div.term-search');
  private searchInput = h('input', { placeholder: 'search…', spellcheck: 'false' });
  private nextTab = 1;
  private infoTimer: ReturnType<typeof setInterval> | null = null;
  private offData: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  private restoreState: { tabs: { dir: 'row' | 'column'; sessions: string[] }[]; active: number } | null = null;
  private fitAll = debounce(() => this.fitVisible(), 40);

  constructor(ctx: ModuleContext) {
    super(ctx);
    terminals.all.add(this);
  }

  mount(): void {
    const ctx = this.ctx;
    ctx.body.classList.add('flush', 'term-body');
    this.searchBar.hidden = true;
    this.searchBar.append(
      this.searchInput,
      h('button.ghost', { title: 'Previous', onclick: () => this.pane()?.search.findPrevious(this.searchInput.value) }, '↑'),
      h('button.ghost', { title: 'Next', onclick: () => this.pane()?.search.findNext(this.searchInput.value) }, '↓'),
      h('button.ghost', { title: 'Close', onclick: () => this.toggleSearch(false) }, '✕'),
    );
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.shiftKey ? this.pane()?.search.findPrevious(this.searchInput.value) : this.pane()?.search.findNext(this.searchInput.value));
      if (e.key === 'Escape') this.toggleSearch(false);
    });
    const add = h('li.term-add', { title: 'New tab', onclick: () => void this.addTab() }, h('p', '+'));
    this.tabBar.append(add);
    ctx.body.append(this.tabBar, this.stage, this.searchBar);
    this.offData = bridge.pty.onData((id, data) => this.onData(id, data));
    this.offExit = bridge.pty.onExit((id, code) => this.onExit(id, code));
    this.infoTimer = setInterval(() => void this.refreshInfo(), 2000);
    // Defer session creation one tick so a restore() (workspace switch) can attach instead.
    queueMicrotask(() => {
      if (this.restoreState) return;
      const n = Math.max(1, Math.min(8, this.ctx.config<number>('tabs', 1)));
      void this.addTab().then(async () => {
        for (let i = 1; i < n; i++) await this.addTab(false);
        this.selectTab(0);
      });
    });
  }

  // ───────── tabs & panes ─────────

  private pane(): Pane | null {
    const tab = this.tabs[this.active];
    return tab?.panes[tab.focused] ?? null;
  }

  async addTab(select = true, sessions?: string[], dir: 'row' | 'column' = 'row'): Promise<void> {
    const id = this.nextTab++;
    const el = h('div.term-tab-content', { style: `flex-direction:${dir}` });
    const tabEl = h('li', { role: 'tab', tabindex: '0', onclick: () => this.selectTab(this.tabs.findIndex((t) => t.id === id)) }, h('p', `#${id}`));
    tabEl.addEventListener('auxclick', (e) => { if ((e as MouseEvent).button === 1) void this.closeTab(this.tabs.findIndex((t) => t.id === id)); });
    this.tabBar.insertBefore(tabEl, this.tabBar.lastElementChild);
    this.stage.append(el);
    const tab: Tab = { id, el, tabEl, panes: [], dir, focused: 0 };
    this.tabs.push(tab);
    if (sessions?.length) for (const s of sessions) await this.addPane(tab, s);
    else await this.addPane(tab);
    if (select) this.selectTab(this.tabs.length - 1);
    this.ctx.app.sounds.play('panels', 0.4);
  }

  private makeTheme(t: Theme): ITheme {
    const term = t.terminal;
    const opacity = this.ctx.app.get<number>('terminal.opacity');
    const bg = opacity >= 0.999 ? term.background : withAlphaCss(term.background, opacity);
    return {
      background: bg, foreground: term.foreground, cursor: term.cursor, cursorAccent: term.cursor_accent, selectionBackground: term.selection,
      black: term.black, red: term.red, green: term.green, yellow: term.yellow, blue: term.blue, magenta: term.magenta, cyan: term.cyan, white: term.white,
      brightBlack: term.bright_black, brightRed: term.bright_red, brightGreen: term.bright_green, brightYellow: term.bright_yellow, brightBlue: term.bright_blue, brightMagenta: term.bright_magenta, brightCyan: term.bright_cyan, brightWhite: term.bright_white,
    };
  }

  private termOptions() {
    const app = this.ctx.app;
    const t = this.ctx.theme();
    return {
      fontFamily: `"${app.get<string>('terminal.font_family') || t.typography.mono_font}", "Fira Mono", monospace`,
      fontSize: app.get<number>('terminal.font_size'),
      lineHeight: app.get<number>('terminal.line_height'),
      letterSpacing: app.get<number>('terminal.letter_spacing'),
      cursorStyle: app.get<'block' | 'underline' | 'bar'>('terminal.cursor_style'),
      cursorBlink: app.get<boolean>('terminal.cursor_blink'),
      scrollback: app.get<number>('terminal.scrollback'),
      allowTransparency: app.get<number>('terminal.opacity') < 1,
      theme: this.makeTheme(t),
    };
  }

  private async addPane(tab: Tab, attachTo?: string): Promise<Pane | null> {
    if (tab.panes.length >= 4) return null;
    const app = this.ctx.app;
    const el = h('div.term-pane');
    tab.el.append(el);
    const term = new Terminal({ ...this.termOptions(), allowProposedApi: true, convertEol: false, macOptionIsMeta: true, rightClickSelectsWord: !app.get<boolean>('terminal.right_click_paste'), smoothScrollDuration: 0, drawBoldTextInBrightColors: true });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_e, uri) => void this.openLink(uri)));
    term.open(el);
    const pane: Pane = { el, term, fit, search, webgl: null, sessionId: null, token: '', shell: '', exited: false, title: '', cwd: null, disposers: [] };
    this.applyRenderer(pane);
    tab.panes.push(pane);
    el.addEventListener('pointerdown', () => { tab.focused = tab.panes.indexOf(pane); terminals.active = this; });
    el.addEventListener('contextmenu', (e) => {
      if (!app.get<boolean>('terminal.right_click_paste')) return;
      e.preventDefault();
      void this.paste();
    });
    pane.disposers.push(term.onData((d) => {
      if (pane.exited) {
        if (d === '\r') void this.restartPane(pane);
        return;
      }
      if (pane.sessionId) void bridge.pty.write(pane.sessionId, d);
      app.sounds.play('stdin', 0.4);
    }).dispose);
    pane.disposers.push(term.onBinary((d) => pane.sessionId && void bridge.pty.write(pane.sessionId, d)).dispose);
    pane.disposers.push(term.onResize(({ cols, rows }) => pane.sessionId && !pane.exited && void bridge.pty.resize(pane.sessionId, cols, rows)).dispose);
    pane.disposers.push(term.onSelectionChange(() => {
      if (app.get<boolean>('terminal.copy_on_select') && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
    }).dispose);
    pane.disposers.push(term.onBell(() => {
      const mode = app.get<string>('terminal.bell');
      if (mode === 'sound') app.sounds.play('alarm', 0.5);
      if (mode === 'visual') { el.classList.add('bell'); setTimeout(() => el.classList.remove('bell'), 180); }
    }).dispose);
    pane.disposers.push(term.onTitleChange((t) => { pane.title = t; this.renderTabTitles(); }).dispose);
    // Authenticated application-command bridge (see resources/bin/synapse).
    pane.disposers.push(term.parser.registerOscHandler(7701, (data) => {
      void this.handleAppCommand(pane, data);
      return true;
    }).dispose);
    try { fit.fit(); } catch { /* not visible yet */ }
    const cols = Math.max(20, term.cols), rows = Math.max(5, term.rows);
    try {
      if (attachTo) {
        const r = await bridge.pty.attach(attachTo);
        pane.sessionId = attachTo;
        pane.token = r.token;
        pane.shell = r.shell;
        term.write(r.replay);
        void bridge.pty.resize(attachTo, cols, rows);
      } else {
        const r = await bridge.pty.create({ cols, rows, shell: this.ctx.config<string>('shell', '') || undefined });
        pane.sessionId = r.id;
        pane.token = r.token;
        pane.shell = r.shell;
        pane.cwd = r.cwd;
      }
    } catch (e) {
      term.write(`\r\n\x1b[31m[SYNAPSE-UI] could not start shell: ${(e as Error).message}\x1b[0m\r\n`);
      pane.exited = true;
    }
    this.layoutTab(tab);
    this.renderTabTitles();
    return pane;
  }

  private applyRenderer(pane: Pane): void {
    const want = this.ctx.app.get<string>('terminal.renderer') === 'webgl';
    if (want && !pane.webgl) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); pane.webgl = null; });
        pane.term.loadAddon(addon);
        pane.webgl = addon;
      } catch {
        pane.webgl = null;
      }
    } else if (!want && pane.webgl) {
      pane.webgl.dispose();
      pane.webgl = null;
    }
  }

  private async restartPane(pane: Pane): Promise<void> {
    pane.exited = false;
    pane.term.reset();
    try {
      const r = await bridge.pty.create({ cols: pane.term.cols, rows: pane.term.rows, shell: this.ctx.config<string>('shell', '') || undefined });
      pane.sessionId = r.id;
      pane.token = r.token;
      pane.shell = r.shell;
    } catch (e) {
      pane.term.write(`\r\n[could not restart: ${(e as Error).message}]\r\n`);
      pane.exited = true;
    }
  }

  private layoutTab(tab: Tab): void {
    tab.el.style.flexDirection = tab.dir;
    this.fitAll();
  }

  selectTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.active = i;
    this.tabs.forEach((t, j) => {
      t.el.classList.toggle('active', j === i);
      t.tabEl.classList.toggle('active', j === i);
      t.tabEl.setAttribute('aria-selected', String(j === i));
    });
    this.fitAll();
    requestAnimationFrame(() => this.pane()?.term.focus());
  }

  async closeTab(i: number): Promise<void> {
    const tab = this.tabs[i];
    if (!tab) return;
    for (const p of tab.panes) this.disposePane(p, true);
    tab.el.remove();
    tab.tabEl.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) await this.addTab();
    this.selectTab(Math.min(i, this.tabs.length - 1));
  }

  async split(dir: 'row' | 'column'): Promise<void> {
    const tab = this.tabs[this.active];
    if (!tab) return;
    if (tab.panes.length >= 4) {
      this.ctx.app.overlays.toast('A tab holds at most 4 panes', 'warn');
      return;
    }
    tab.dir = dir;
    await this.addPane(tab);
    tab.focused = tab.panes.length - 1;
    this.layoutTab(tab);
    requestAnimationFrame(() => this.pane()?.term.focus());
  }

  focusNextPane(): void {
    const tab = this.tabs[this.active];
    if (!tab?.panes.length) return;
    tab.focused = (tab.focused + 1) % tab.panes.length;
    tab.panes[tab.focused].term.focus();
  }

  cycleTab(dir: 1 | -1): void {
    if (this.tabs.length) this.selectTab((this.active + dir + this.tabs.length) % this.tabs.length);
  }

  closeActiveTab(): void {
    void this.closeTab(this.active);
  }

  private disposePane(p: Pane, kill: boolean): void {
    for (const d of p.disposers) {
      try { d(); } catch { /* ignore */ }
    }
    if (kill && p.sessionId && !p.exited) void bridge.pty.kill(p.sessionId).catch(() => {});
    p.webgl?.dispose();
    p.term.dispose();
    p.el.remove();
  }

  // ───────── I/O ─────────

  private findPane(id: string): Pane | null {
    for (const t of this.tabs) for (const p of t.panes) if (p.sessionId === id) return p;
    return null;
  }

  private onData(id: string, data: string): void {
    const p = this.findPane(id);
    if (!p) return;
    p.term.write(data);
    this.ctx.app.sounds.play('stdout', 0.25);
  }

  private onExit(id: string, code: number): void {
    const p = this.findPane(id);
    if (!p) return;
    p.exited = true;
    p.term.write(`\r\n\x1b[2m[process exited with code ${code} — press Enter to start a new shell]\x1b[0m\r\n`);
  }

  write(data: string): void {
    const p = this.pane();
    if (p?.sessionId && !p.exited) void bridge.pty.write(p.sessionId, data);
  }

  copy(): void {
    const p = this.pane();
    if (p?.term.hasSelection()) {
      void navigator.clipboard.writeText(p.term.getSelection());
      this.ctx.app.overlays.toast('Copied', 'ok', 1000);
    }
  }

  async paste(): Promise<void> {
    const p = this.pane();
    if (!p) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) p.term.paste(text);
    } catch (e) {
      this.ctx.app.overlays.toast(`Clipboard unavailable: ${(e as Error).message}`, 'warn');
    }
  }

  toggleSearch(show?: boolean): void {
    this.searchBar.hidden = !(show ?? this.searchBar.hidden);
    if (!this.searchBar.hidden) { this.searchInput.focus(); this.searchInput.select(); }
    else { this.pane()?.search.clearDecorations(); this.pane()?.term.focus(); }
  }

  fontStep(delta: number): void {
    const size = Math.max(6, Math.min(40, this.ctx.app.get<number>('terminal.font_size') + delta));
    void this.ctx.app.set({ 'terminal.font_size': size });
  }

  currentCwd(): string | null {
    return this.pane()?.cwd ?? null;
  }

  private async openLink(uri: string): Promise<void> {
    const app = this.ctx.app;
    const policy = app.get<string>('security.external_links');
    if (policy === 'deny') return app.overlays.toast('Opening links is disabled (Settings → Advanced)', 'warn');
    if (policy === 'ask') {
      const ok = await app.overlays.confirm({ title: 'Open link', message: `Open this address in your web browser?\n\n${uri}`, confirm: 'Open' });
      if (!ok) return;
    }
    await bridge.app.openExternal(uri);
  }

  /** OSC 7701 ; <token> ; <base64 args joined by \x1f> — reply "ok:<b64>\n" or "err:<b64>\n". */
  private async handleAppCommand(pane: Pane, data: string): Promise<void> {
    const app = this.ctx.app;
    const i = data.indexOf(';');
    const token = data.slice(0, i);
    const payload = data.slice(i + 1);
    if (!app.get<boolean>('terminal.app_commands') || !pane.sessionId) return;
    if (i < 0 || token.length < 16 || !timingSafeEqual(token, pane.token)) {
      void bridge.app.log('warn', 'rejected synapse command with an invalid token');
      return;
    }
    let words: string[];
    try {
      words = decoder.decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))).split('\x1f').filter((w, k, a) => !(k === a.length - 1 && w === ''));
    } catch {
      return;
    }
    const r = await app.commands.execute(words);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(r.output)));
    await bridge.pty.reply(pane.sessionId, `${r.ok ? 'ok' : 'err'}:${b64}\n`);
  }

  private async refreshInfo(): Promise<void> {
    if (!this.ctx.visible()) return;
    const tab = this.tabs[this.active];
    if (!tab) return;
    for (const p of tab.panes) {
      if (!p.sessionId || p.exited) continue;
      try {
        const info = await bridge.pty.info(p.sessionId);
        p.cwd = info.cwd;
        p.title = info.process ?? p.title;
      } catch { /* session gone */ }
    }
    this.renderTabTitles();
  }

  private renderTabTitles(): void {
    const mode = this.ctx.app.get<string>('terminal.tab_title');
    this.tabs.forEach((t) => {
      const p = t.panes[t.focused] ?? t.panes[0];
      if (!p) return;
      const label = mode === 'cwd' ? (p.cwd?.split(/[\\/]/).pop() || p.cwd || p.shell) : mode === 'shell' ? p.shell : p.title || p.shell;
      t.tabEl.firstElementChild!.textContent = `${label || 'shell'}${t.panes.length > 1 ? ` ×${t.panes.length}` : ''}`;
      t.tabEl.title = p.cwd ?? '';
    });
    const p = this.pane();
    this.ctx.setStatus(p ? `${p.shell.toUpperCase()}${p.cwd ? ' — ' + p.cwd : ''}` : '');
  }

  private fitVisible(): void {
    const tab = this.tabs[this.active];
    if (!tab || !this.ctx.body.isConnected) return;
    for (const p of tab.panes) {
      try { p.fit.fit(); } catch { /* hidden */ }
    }
  }

  // ───────── lifecycle ─────────

  resize(): void {
    this.fitAll();
  }

  focus(): void {
    terminals.active = this;
    this.pane()?.term.focus();
  }

  onTheme(): void {
    const opts = this.termOptions();
    for (const t of this.tabs) for (const p of t.panes) p.term.options.theme = opts.theme;
  }

  onConfig(changed: string[]): void {
    if (!changed.some((k) => k.startsWith('terminal.'))) return;
    const opts = this.termOptions();
    for (const t of this.tabs) for (const p of t.panes) {
      Object.assign(p.term.options, opts);
      if (changed.includes('terminal.renderer')) this.applyRenderer(p);
    }
    this.fitAll();
    this.renderTabTitles();
  }

  serialize(): Record<string, unknown> {
    return { tabs: this.tabs.map((t) => ({ dir: t.dir, sessions: t.panes.map((p) => p.sessionId).filter(Boolean) })), active: this.active };
  }

  restore(state: Record<string, unknown>): void {
    const s = state as TerminalModule['restoreState'];
    if (!s?.tabs?.length) return;
    this.restoreState = s;
    void (async () => {
      for (const t of s.tabs) await this.addTab(false, t.sessions, t.dir);
      this.selectTab(Math.min(s.active, this.tabs.length - 1));
    })();
  }

  dispose(reason: DisposeReason): void {
    const kill = reason === 'remove' || reason === 'shutdown';
    if (this.infoTimer) clearInterval(this.infoTimer);
    this.offData?.();
    this.offExit?.();
    for (const t of this.tabs) for (const p of t.panes) this.disposePane(p, kill);
    this.tabs = [];
    terminals.all.delete(this);
    if (terminals.active === this) terminals.active = null;
  }
}

function withAlphaCss(color: string, a: number): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

registerModuleType({
  manifest: {
    id: 'terminal',
    name: 'Terminal',
    version: '1.0.0',
    description: 'Real shell sessions with tabs, splits, search and scrollback. Sessions survive workspace switches.',
    author: 'SYNAPSE-UI (eDEX-UI lineage)',
    category: 'terminal',
    permissions: ['pty.spawn', 'terminal.write'],
    rendering: 'dom',
    defaultSize: { colSpan: 2, rowSpan: 2, w: 0.38, h: 0.34 },
    configSchema: [
      { key: 'tabs', label: 'Initial tabs', type: 'int', default: 1, min: 1, max: 8 },
      { key: 'shell', label: 'Shell override (empty = global)', type: 'string', default: '' },
    ],
  },
  create: (ctx) => new TerminalModule(ctx),
});

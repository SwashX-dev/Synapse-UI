/**
 * Filesystem browser and on-screen keyboard — ported from eDEX-UI's
 * filesystem.class.js and keyboard.class.js onto the module API. Both talk to
 * the active terminal; the filesystem view is read-only.
 */
import { SynModule, registerModuleType, type ModuleContext } from '../workspace/module';
import { bridge } from '../core/bridge';
import { formatBytes, h } from '../core/util';
import { terminals } from './terminal';
import type { FsEntry } from '../../shared/ipc';
import type { StorageItem } from '../core/monitor';

// ───────────────────────── filesystem ─────────────────────────

const EXT_KIND: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i, 'img'], [/\.(mp3|wav|ogg|flac|m4a|opus)$/i, 'aud'], [/\.(mp4|mkv|webm|mov|avi)$/i, 'vid'],
  [/\.(zip|tar|gz|xz|bz2|7z|rar|zst)$/i, 'arc'], [/\.(js|ts|tsx|jsx|py|rs|go|c|h|cpp|java|rb|sh|nix|lua|zig|hs|kt|swift)$/i, 'src'],
  [/\.(md|txt|rst|log|toml|ya?ml|json|ini|conf|cfg|csv|xml|html|css)$/i, 'txt'], [/\.(pdf|epub|docx?|odt)$/i, 'doc'],
];
const ICON: Record<string, string> = { dir: '▣', up: '⇡', img: '▧', aud: '♪', vid: '▶', arc: '▦', src: '❮❯', txt: '≡', doc: '▤', bin: '◆', file: '▢', link: '⇢', other: '◇' };

class FilesystemModule extends SynModule {
  private dir = '';
  private grid = h('div.fs-grid.scroll');
  private crumbs = h('div.fs-crumbs.mono');
  private footer = h('div.fs-footer');
  private follow: ReturnType<typeof setInterval> | null = null;
  private lastTermCwd: string | null = null;
  private entries: FsEntry[] = [];
  private storageOff: (() => void) | null = null;

  async mount(): Promise<void> {
    this.ctx.body.classList.add('fs-body');
    this.ctx.body.append(this.crumbs, this.grid, this.footer);
    await this.go(await bridge.fs.home());
    this.follow = setInterval(() => this.checkTerminal(), 1200);
    this.storageOff = this.ctx.app.monitor.subscribe('storage', () => this.renderFooter());
  }

  private checkTerminal(): void {
    if (!this.ctx.app.get<boolean>('filesystem.follow_terminal') || !this.ctx.visible()) return;
    const t = terminals.active ?? [...terminals.all][0];
    const cwd = t?.currentCwd();
    if (cwd && cwd !== this.lastTermCwd) {
      this.lastTermCwd = cwd;
      if (cwd !== this.dir) void this.go(cwd, false);
    }
  }

  private async go(dir: string, cdTerminal = false): Promise<void> {
    try {
      const r = await bridge.fs.list(dir);
      this.dir = r.dir;
      this.entries = r.entries;
      if (cdTerminal && this.ctx.app.get<boolean>('filesystem.follow_terminal')) {
        const t = terminals.active ?? [...terminals.all][0];
        t?.write(`cd '${r.dir.replace(/'/g, `'\\''`)}'\r`);
        this.lastTermCwd = r.dir;
      }
      this.render(r.parent);
      this.ctx.app.sounds.play('folder', 0.5);
    } catch (e) {
      this.ctx.app.overlays.toast(`Cannot open ${dir}: ${(e as Error).message}`, 'error');
      this.ctx.app.sounds.play('denied');
    }
  }

  private render(parent: string): void {
    const showHidden = this.ctx.app.get<boolean>('filesystem.show_hidden');
    const list = this.ctx.app.get<boolean>('filesystem.list_view');
    this.grid.classList.toggle('list', list);
    const sep = this.dir.includes('\\') ? '\\' : '/';
    const parts = this.dir.split(/[\\/]/).filter(Boolean);
    this.crumbs.replaceChildren(...[h('span', { onclick: () => void this.go(sep === '/' ? '/' : parts[0] + '\\', true) }, sep === '/' ? '/' : ''), ...parts.map((p, i) => h('span', { onclick: () => void this.go((sep === '/' ? '/' : '') + parts.slice(0, i + 1).join(sep), true) }, p + sep))]);
    this.ctx.setStatus(this.dir);
    const items = this.entries.filter((e) => showHidden || !e.hidden).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    const cell = (icon: string, name: string, meta: string, onOpen: () => void, cls = '') =>
      h('div.fs-item', { class: cls, tabindex: '0', title: name, ondblclick: onOpen, onkeydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && onOpen() }, h('span.ico', icon), h('span.nm', name), list ? h('span.meta.mono', meta) : '');
    this.grid.replaceChildren(
      ...(parent !== this.dir ? [cell(ICON.up, '..', '', () => void this.go(parent, true), 'up')] : []),
      ...items.slice(0, 1500).map((e) => {
        const kind = e.type === 'dir' ? 'dir' : e.type === 'symlink' ? 'link' : e.type === 'other' ? 'other' : EXT_KIND.find(([re]) => re.test(e.name))?.[1] ?? 'file';
        const meta = e.type === 'dir' ? 'DIR' : `${formatBytes(e.size)}  ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ') : ''}`;
        return cell(ICON[kind] ?? ICON.file, e.name, meta, () => (e.type === 'dir' ? void this.go(e.path, true) : void this.preview(e)), kind);
      }),
    );
    this.renderFooter();
  }

  private renderFooter(): void {
    const mounts = this.ctx.app.monitor.get<StorageItem[]>('storage') ?? [];
    const m = mounts.filter((x) => this.dir.startsWith(x.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
    if (!m) { this.footer.textContent = `${this.entries.length} ENTRIES`; return; }
    const i = h('i');
    i.style.width = `${m.use}%`;
    this.footer.replaceChildren(h('span.mono', `MOUNT ${m.mount} · ${formatBytes(m.available)} FREE`), h('div.bar.grow', i));
  }

  private async preview(e: FsEntry): Promise<void> {
    const app = this.ctx.app;
    try {
      const r = await bridge.fs.readText(e.path);
      const p = app.overlays.panel(`preview-${e.path}`, e.name, { width: 'min(900px, 90vw)', height: 'min(80vh, 900px)', subtitle: `${formatBytes(r.size)}${r.truncated ? ' · first 512 KiB' : ''}` });
      p.body.append(r.binary ? h('div.na', 'Binary file — preview not available.') : h('pre.preview.scroll', r.text));
    } catch (err) {
      app.overlays.toast(`Cannot read ${e.name}: ${(err as Error).message}`, 'error');
    }
  }

  onConfig(changed: string[]): void {
    if (changed.some((k) => k.startsWith('filesystem.'))) void this.go(this.dir);
  }

  dispose(): void {
    if (this.follow) clearInterval(this.follow);
    this.storageOff?.();
  }
}
registerModuleType({
  manifest: { id: 'filesystem', name: 'Filesystem', version: '1.0.0', description: 'eDEX-style file browser that follows the active terminal’s working directory (read-only; opening a folder runs `cd` in the terminal).', author: 'SYNAPSE-UI (eDEX-UI lineage)', category: 'utility', permissions: ['filesystem.read', 'terminal.write'], rendering: 'dom', defaultSize: { colSpan: 1, rowSpan: 2, w: 0.3, h: 0.3 }, configSchema: [] },
  create: (c) => new FilesystemModule(c),
});

// ───────────────────────── on-screen keyboard ─────────────────────────

interface KeyDef { name: string; cmd: string; shift_name?: string; shift_cmd?: string; alt_cmd?: string; fn_name?: string; fn_cmd?: string; ctrl_cmd?: string }
type Layout = Record<'row_numbers' | 'row_1' | 'row_2' | 'row_3' | 'row_space', KeyDef[]>;

/** eDEX-UI's control-sequence table (index → character). */
const CTRLSEQ = [null, 27, 28, 29, 30, 31, 17, 23, 18, 18, 25, 21, 16, 1, 19, 4, 6, 26, 24, 3, 22, 2].map((c) => (c === null ? '' : String.fromCharCode(c)));
const expand = (s: string | undefined) => (s ?? '').replace(/~~~CTRLSEQ(\d+)~~~/g, (_m, i) => CTRLSEQ[Number(i)] ?? '');
const ARROWS: Record<string, string> = { ARROW_UP: '▲', ARROW_DOWN: '▼', ARROW_LEFT: '◀', ARROW_RIGHT: '▶' };
const ARROW_SEQ: Record<string, string> = { ARROW_UP: '\x1bOA', ARROW_DOWN: '\x1bOB', ARROW_RIGHT: '\x1bOC', ARROW_LEFT: '\x1bOD' };

class KeyboardModule extends SynModule {
  private root = h('div.kb');
  private layout: Layout | null = null;
  private mods = { shift: false, ctrl: false, alt: false, fn: false, caps: false };
  private keyEls: { el: HTMLElement; def: KeyDef }[] = [];
  private onDown = (e: KeyboardEvent) => this.mirror(e, true);
  private onUp = (e: KeyboardEvent) => this.mirror(e, false);

  async mount(): Promise<void> {
    this.ctx.body.append(this.root);
    await this.load();
    window.addEventListener('keydown', this.onDown, true);
    window.addEventListener('keyup', this.onUp, true);
  }

  private async load(): Promise<void> {
    const id = this.ctx.app.get<string>('keyboard.layout');
    this.layout = ((await bridge.config.kbLayout(id)) ?? (await bridge.config.kbLayout('en-US'))) as Layout | null;
    this.ctx.setStatus(`LAYOUT ${id}`);
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();
    this.keyEls = [];
    if (!this.layout) { this.root.append(h('div.na', 'Keyboard layout not found.')); return; }
    for (const row of ['row_numbers', 'row_1', 'row_2', 'row_3', 'row_space'] as const) {
      const r = h('div.kb-row', { class: row });
      for (const def of this.layout[row] ?? []) {
        const icon = def.name.startsWith('ESCAPED|-- ICON: ') ? def.name.slice(17) : null;
        const label = icon ? ARROWS[icon] ?? icon : def.name;
        const el = h('div.kb-key', { 'data-cmd': def.cmd, class: def.cmd === ' ' ? 'space' : def.cmd.startsWith('ESCAPED|--') ? 'mod' : '' }, h('span.main', label), def.shift_name ? h('span.shift', def.shift_name) : '', def.fn_name ? h('span.fn', def.fn_name) : '');
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.press(def, icon);
        });
        r.append(el);
        this.keyEls.push({ el, def });
      }
      this.root.append(r);
    }
    this.syncMods();
  }

  private press(def: KeyDef, icon: string | null): void {
    const cmd = def.cmd;
    if (icon && ARROW_SEQ[icon]) return this.send(ARROW_SEQ[icon]);
    if (cmd.startsWith('ESCAPED|-- ')) {
      const what = cmd.slice(11);
      if (what.startsWith('SHIFT')) this.mods.shift = !this.mods.shift;
      else if (what.startsWith('CTRL')) this.mods.ctrl = !this.mods.ctrl;
      else if (what.startsWith('ALT')) this.mods.alt = !this.mods.alt;
      else if (what.startsWith('FN')) this.mods.fn = !this.mods.fn;
      else if (what.startsWith('CAPSLCK')) this.mods.caps = !this.mods.caps;
      this.syncMods();
      return;
    }
    let out = cmd;
    if (this.mods.ctrl && def.ctrl_cmd) out = def.ctrl_cmd;
    else if (this.mods.fn && def.fn_cmd) out = def.fn_cmd;
    else if (this.mods.alt && def.alt_cmd) out = def.alt_cmd;
    else if ((this.mods.shift || this.mods.caps) && def.shift_cmd) out = def.shift_cmd;
    out = expand(out);
    if (out === '\n' || def.name === 'ENTER') out = '\r';
    this.send(out);
    if (this.mods.shift || this.mods.ctrl || this.mods.alt) {
      this.mods.shift = this.mods.ctrl = this.mods.alt = false;
      this.syncMods();
    }
  }

  private send(data: string): void {
    const t = terminals.active ?? [...terminals.all][0];
    if (!t) { this.ctx.app.sounds.play('denied'); return; }
    t.write(data);
    this.ctx.app.sounds.play('keyboard', 0.5);
  }

  private syncMods(): void {
    this.root.classList.toggle('shift', this.mods.shift || this.mods.caps);
    this.root.classList.toggle('fn', this.mods.fn);
    for (const { el, def } of this.keyEls) {
      const c = def.cmd;
      el.classList.toggle('active', (c.includes('SHIFT') && this.mods.shift) || (c.includes('CTRL') && this.mods.ctrl) || (c.includes('ALT') && this.mods.alt) || (c.includes('FN: ON') && this.mods.fn) || (c.includes('CAPSLCK: ON') && this.mods.caps));
    }
  }

  /** Light up keys pressed on the physical keyboard. */
  private mirror(e: KeyboardEvent, down: boolean): void {
    if (!this.ctx.app.get<boolean>('keyboard.show_physical') || !this.ctx.visible()) return;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const map: Record<string, string> = { ' ': ' ', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BACK', Escape: 'ESC', Shift: 'SHIFT', Control: 'CTRL', Alt: 'FN', CapsLock: 'CAPS', ArrowUp: '▲', ArrowDown: '▼', ArrowLeft: '◀', ArrowRight: '▶' };
    const target = map[e.key] ?? key;
    for (const { el, def } of this.keyEls) {
      const label = el.firstElementChild?.textContent ?? '';
      if (label.toUpperCase() === target || (target === ' ' && def.cmd === ' ') || (def.shift_name && def.shift_name === e.key)) el.classList.toggle('pressed', down);
    }
  }

  onConfig(changed: string[]): void {
    if (changed.includes('keyboard.layout')) void this.load();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown, true);
    window.removeEventListener('keyup', this.onUp, true);
  }
}
registerModuleType({
  manifest: { id: 'keyboard', name: 'On-screen Keyboard', version: '1.0.0', description: 'The eDEX-UI touch keyboard (19 layouts) typing into the active terminal and mirroring physical key presses.', author: 'SYNAPSE-UI (eDEX-UI lineage)', category: 'utility', permissions: ['terminal.write'], rendering: 'dom', defaultSize: { colSpan: 2, rowSpan: 2, w: 0.42, h: 0.3 }, configSchema: [] },
  create: (c) => new KeyboardModule(c),
});

export type { ModuleContext };

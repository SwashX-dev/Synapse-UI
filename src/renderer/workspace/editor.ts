/**
 * Graphical workspace editor (Ctrl+Shift+E): select, drag, resize, snap,
 * duplicate, remove, add (drag from the module library), layer, fade, rotate,
 * lock, pin, group, dock/float, resize grid tracks, undo/redo, save/restore.
 * Every change is applied to the live workspace immediately.
 */
import type { App } from '../core/app';
import { h } from '../core/util';
import { moduleTypes } from './module';
import {
  History, addModule, clone, duplicateModules, gridCellRect, gridLines, groupMembers, groupModules, isDocked, moveFloating, pointToCell, removeModules, reorder, resizeTrack, setFloatingRect,
  setGridPlacement, setGridSpec, snapRect, ungroupModules, updateModule, type LayoutMode, type ModuleInstance, type Rect, type Workspace,
} from '../../shared/workspace';
import { BUILTIN_WORKSPACES } from '../../shared/profiles';

type Edge = { left: boolean; right: boolean; top: boolean; bottom: boolean };
const HANDLES: [string, Edge][] = [
  ['nw', { left: true, right: false, top: true, bottom: false }], ['n', { left: false, right: false, top: true, bottom: false }], ['ne', { left: false, right: true, top: true, bottom: false }],
  ['e', { left: false, right: true, top: false, bottom: false }], ['se', { left: false, right: true, top: false, bottom: true }], ['s', { left: false, right: false, top: false, bottom: true }],
  ['sw', { left: true, right: false, top: false, bottom: true }], ['w', { left: true, right: false, top: false, bottom: false }],
];

export class WorkspaceEditor {
  active = false;
  private root = h('div.ws-editor', { 'aria-label': 'Workspace editor' });
  private layer = h('div.ws-layer');
  private guides = h('div.ws-guides');
  private toolbar = h('div.ws-toolbar');
  private library = h('aside.ws-library.scroll');
  private inspector = h('div.ws-inspector');
  private selection = new Set<string>();
  private history = new History<Workspace>(150);
  private snapshots: { at: number; ws: Workspace }[] = [];
  private offLayout: (() => void) | null = null;
  private dragging = false;

  constructor(private app: App) {
    this.root.append(this.layer, this.guides, this.toolbar, this.library, this.inspector);
    this.layer.addEventListener('pointerdown', (e) => {
      if (e.target === this.layer) { this.selection.clear(); this.render(); }
    });
    this.layer.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
    this.layer.addEventListener('drop', (e) => this.onDrop(e));
  }

  private get ws(): Workspace {
    return this.app.workspace.current!;
  }

  toggle(): void {
    if (this.active) this.close();
    else this.open();
  }

  open(): void {
    if (!this.app.workspace.current || this.active) return;
    this.active = true;
    this.app.overlays.editorOpen = true;
    document.body.classList.add('editing');
    document.getElementById('overlays')!.append(this.root);
    this.snapshots.push({ at: Date.now(), ws: clone(this.ws) });
    this.offLayout = this.app.workspace.events.on('layout', () => { if (!this.dragging) this.render(); });
    this.buildToolbar();
    this.buildLibrary();
    this.render();
    this.app.sounds.play('expand');
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.app.overlays.editorOpen = false;
    document.body.classList.remove('editing');
    this.root.remove();
    this.offLayout?.();
    this.selection.clear();
    void this.app.workspace.saveNow();
    this.app.sounds.play('panels');
  }

  /** Apply a new workspace definition with undo history. */
  commit(next: Workspace): void {
    this.history.push(this.ws);
    this.app.workspace.apply(next);
    this.render();
  }

  undo(): void {
    const prev = this.history.undo(this.ws);
    if (prev) { this.app.workspace.apply(prev); this.render(); }
  }

  redo(): void {
    const nxt = this.history.redo(this.ws);
    if (nxt) { this.app.workspace.apply(nxt); this.render(); }
  }

  duplicateSelection(): void {
    if (!this.selection.size) return;
    const r = duplicateModules(this.ws, [...this.selection]);
    this.commit(r.ws);
    this.selection = new Set(r.newIds);
    this.render();
  }

  async removeSelection(): Promise<void> {
    if (!this.selection.size) return;
    const names = [...this.selection].map((id) => this.ws.modules.find((m) => m.id === id)?.title || this.ws.modules.find((m) => m.id === id)?.type).join(', ');
    const hasTerminal = [...this.selection].some((id) => this.ws.modules.find((m) => m.id === id)?.type === 'terminal');
    if (hasTerminal && !(await this.app.overlays.confirm({ title: 'Remove modules', message: `Remove ${names}?\nRunning shells in removed terminals will be closed.`, confirm: 'Remove', danger: true }))) return;
    this.commit(removeModules(this.ws, [...this.selection]));
    this.selection.clear();
    this.render();
  }

  // ───────────────────────── toolbar & library ─────────────────────────

  private buildToolbar(): void {
    const ws = this.ws;
    const mode = h('select', { title: 'Layout mode' }, ...(['grid', 'freeform', 'hybrid'] as LayoutMode[]).map((m) => h('option', { value: m }, m.toUpperCase())));
    mode.value = ws.mode;
    mode.addEventListener('change', () => this.commit({ ...clone(this.ws), mode: mode.value as LayoutMode }));
    const num = (label: string, value: number, min: number, max: number, on: (v: number) => void) => {
      const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(value), class: 'num', title: label });
      i.addEventListener('change', () => on(Math.max(min, Math.min(max, Math.round(Number(i.value) || value)))));
      return h('label.tb-num', h('span.label', label), i);
    };
    const snap = h('input', { type: 'checkbox', title: 'Snapping' });
    snap.checked = this.app.get<boolean>('interface.grid_snapping');
    snap.addEventListener('change', () => void this.app.set({ 'interface.grid_snapping': snap.checked }));
    const b = (label: string, title: string, fn: () => void, cls = '') => h('button', { title, onclick: fn, class: cls }, label);
    const snapshotSel = h('select', { title: 'Restore a previous layout' }, h('option', { value: '' }, 'RESTORE…'), ...this.snapshots.map((s, i) => h('option', { value: String(i) }, new Date(s.at).toLocaleTimeString())));
    snapshotSel.addEventListener('change', () => {
      const s = this.snapshots[Number(snapshotSel.value)];
      if (s) this.commit(clone(s.ws));
      snapshotSel.value = '';
    });
    this.toolbar.replaceChildren(
      h('span.tb-title', 'WORKSPACE EDITOR'), h('span.tb-sub', ws.name.toUpperCase()),
      mode,
      num('COLS', ws.grid.cols, 1, 48, (v) => this.commit(setGridSpec(this.ws, { cols: v, colSizes: [] }))),
      num('ROWS', ws.grid.rows, 1, 48, (v) => this.commit(setGridSpec(this.ws, { rows: v, rowSizes: [] }))),
      num('GAP', ws.grid.gap, 0, 40, (v) => this.commit(setGridSpec(this.ws, { gap: v }))),
      h('label.tb-num', snap, h('span.label', 'SNAP')),
      b('⧉', 'Duplicate selection (Ctrl+D)', () => this.duplicateSelection()),
      b('✕', 'Remove selection (Delete)', () => void this.removeSelection()),
      b('GROUP', 'Group selected modules', () => this.commit(groupModules(this.ws, [...this.selection]))),
      b('UNGROUP', 'Ungroup', () => this.commit(ungroupModules(this.ws, [...this.selection]))),
      b('↶', 'Undo (Ctrl+Z)', () => this.undo()),
      b('↷', 'Redo (Ctrl+Shift+Z)', () => this.redo()),
      snapshotSel,
      b('SAVE', 'Save layout', () => void this.app.workspace.saveNow().then((ok) => { if (ok) { this.snapshots.push({ at: Date.now(), ws: clone(this.ws) }); this.app.overlays.toast('Workspace saved', 'ok'); this.buildToolbar(); } })),
      b('SAVE AS…', 'Save as a new workspace profile', () => void this.saveAs()),
      BUILTIN_WORKSPACES.some((w) => w.id === ws.id) ? b('RESET', 'Reset this built-in profile to its default layout', () => void this.resetDefault()) : '',
      b('DONE', 'Close the editor (Ctrl+Shift+E)', () => this.close(), 'primary'),
    );
  }

  private async saveAs(): Promise<void> {
    const name = await this.app.overlays.prompt({ title: 'Save workspace as', label: 'Profile name', value: `${this.ws.name} copy`, validate: (v) => (v.trim().length ? null : 'name required') });
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
    await this.app.workspace.saveNow({ id, name: name.trim().slice(0, 64) });
    this.buildToolbar();
    this.app.overlays.toast(`Saved workspace "${name}"`, 'ok');
  }

  private async resetDefault(): Promise<void> {
    if (!(await this.app.overlays.confirm({ title: 'Reset workspace', message: `Restore "${this.ws.name}" to its built-in default layout? Your saved changes to this profile are backed up and replaced.`, confirm: 'Reset', danger: true }))) return;
    this.history.push(this.ws);
    await this.app.workspace.resetToDefault();
    this.render();
  }

  private buildLibrary(): void {
    const entry = (label: string, sub: string, data: string) => {
      const el = h('div.lib-item', { draggable: 'true', title: `${sub}\nDrag into the workspace or click to add`, tabindex: '0' }, h('span.nm', label), h('span.sub', sub));
      el.addEventListener('dragstart', (e) => e.dataTransfer!.setData('application/x-synapse-module', data));
      el.addEventListener('click', () => this.addFromLibrary(data, null));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.addFromLibrary(data, null); });
      return el;
    };
    const types = moduleTypes().filter((t) => t.manifest.id !== 'visualization').sort((a, b) => a.manifest.category.localeCompare(b.manifest.category) || a.manifest.name.localeCompare(b.manifest.name));
    const presets = this.app.presets();
    const cats = ['neural', 'scientific', 'cybernetic', 'abstract', 'custom'];
    this.library.replaceChildren(
      h('h4', 'MODULE LIBRARY'),
      ...types.map((t) => entry(t.manifest.name, t.manifest.category, JSON.stringify({ type: t.manifest.id }))),
      ...cats.flatMap((c) => {
        const list = presets.filter((p) => p.category === c);
        return list.length ? [h('h4', `${c.toUpperCase()} VISUALIZATIONS`), ...list.map((p) => entry(p.name, p.engine, JSON.stringify({ type: 'visualization', preset: p.id })))] : [];
      }),
    );
  }

  private addFromLibrary(data: string, at: { x: number; y: number } | null): void {
    let spec: { type: string; preset?: string };
    try { spec = JSON.parse(data); } catch { return; }
    const t = moduleTypes().find((x) => x.manifest.id === spec.type);
    if (!t) return;
    const { w: W, h: H } = this.app.workspace.workspaceSize;
    const size = t.manifest.defaultSize;
    const config: Record<string, unknown> = spec.preset ? { preset: spec.preset } : {};
    const opts: Parameters<typeof addModule>[2] = { config, defaultSize: size, title: spec.preset ? this.app.preset(spec.preset)?.name : undefined };
    if (at) {
      if (this.ws.mode === 'freeform' || (this.ws.mode === 'hybrid' && !this.dropOnCell(at))) {
        opts.rect = { x: at.x / W - size.w / 2, y: at.y / H - size.h / 2, w: size.w, h: size.h };
        opts.docked = false;
      } else {
        const cell = pointToCell(this.ws.grid, at.x, at.y, W, H);
        opts.cell = { ...cell, colSpan: size.colSpan, rowSpan: size.rowSpan };
        opts.docked = true;
      }
    }
    const r = addModule(this.ws, spec.type, opts);
    this.commit(r.ws);
    this.selection = new Set([r.id]);
    this.render();
    this.app.sounds.play('granted', 0.5);
  }

  /** In hybrid mode, dropping onto an empty grid cell docks; dropping over a module floats. */
  private dropOnCell(at: { x: number; y: number }): boolean {
    return !this.app.workspace.moduleRects().some((m) => at.x >= m.rect.x && at.x <= m.rect.x + m.rect.w && at.y >= m.rect.y && at.y <= m.rect.y + m.rect.h);
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const data = e.dataTransfer?.getData('application/x-synapse-module');
    if (!data) return;
    const r = this.layer.getBoundingClientRect();
    this.addFromLibrary(data, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  // ───────────────────────── rendering handles ─────────────────────────

  render(): void {
    if (!this.active || !this.app.workspace.current) return;
    const ws = this.ws;
    const { w: W, h: H } = this.app.workspace.workspaceSize;
    this.layer.replaceChildren();
    // Grid lines + track resize handles.
    if (ws.mode !== 'freeform') {
      const { xs, ys } = gridLines(ws.grid, W, H);
      xs.forEach((x, i) => {
        const line = h('div.grid-line.v', { style: `left:${x}px` });
        if (i > 0 && i < xs.length - 1) this.trackHandle(line, 'col', i - 1);
        this.layer.append(line);
      });
      ys.forEach((y, i) => {
        const line = h('div.grid-line.h', { style: `top:${y}px` });
        if (i > 0 && i < ys.length - 1) this.trackHandle(line, 'row', i - 1);
        this.layer.append(line);
      });
    }
    const rects = this.app.workspace.moduleRects();
    for (const { id, rect, inst } of rects) {
      const docked = isDocked(ws, inst);
      const sel = this.selection.has(id);
      const box = h('div.ws-box', { class: `${sel ? 'selected' : ''} ${docked ? 'docked' : 'floating'} ${inst.layout.locked ? 'locked' : ''} ${inst.layout.group ? 'grouped' : ''}`, style: `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;z-index:${this.app.workspace.effectiveZ(ws, inst)}${!docked && inst.layout.rotation ? `;transform:rotate(${inst.layout.rotation}deg)` : ''}` },
        h('div.ws-label', h('span', (inst.title || moduleTypes().find((t) => t.manifest.id === inst.type)?.manifest.name || inst.type).toUpperCase()), h('span.dim', `${docked ? `${inst.layout.col},${inst.layout.row} ${inst.layout.colSpan}×${inst.layout.rowSpan}` : 'FLOAT'}${inst.layout.locked ? ' · LOCKED' : ''}${inst.layout.pinned ? ' · PINNED' : ''}${inst.layout.group ? ' · GROUP' : ''}`)),
      );
      box.addEventListener('pointerdown', (e) => this.startMove(e, id));
      box.addEventListener('dblclick', () => this.app.overlays.openModuleSettings(id));
      if (!inst.layout.locked) for (const [name, edge] of HANDLES) {
        const hd = h('div.ws-handle', { class: name });
        hd.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startResize(e, id, edge); });
        box.append(hd);
      }
      this.layer.append(box);
    }
    this.renderInspector();
  }

  private trackHandle(line: HTMLElement, axis: 'col' | 'row', index: number): void {
    line.classList.add('resizable');
    line.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const start = axis === 'col' ? e.clientX : e.clientY;
      const total = axis === 'col' ? this.app.workspace.workspaceSize.w : this.app.workspace.workspaceSize.h;
      const before = clone(this.ws);
      line.setPointerCapture(e.pointerId);
      let applied = 0;
      const move = (ev: PointerEvent) => {
        const d = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / total;
        this.app.workspace.apply(resizeTrack(before, axis, index, d), { save: false });
        applied = d;
        this.dragging = true;
        this.render();
      };
      const up = () => {
        line.removeEventListener('pointermove', move);
        this.dragging = false;
        if (applied) { this.history.push(before); this.app.workspace.apply(this.ws); }
      };
      line.addEventListener('pointermove', move);
      line.addEventListener('pointerup', up, { once: true });
    });
  }

  private snapTargets(exclude: Set<string>): { xs: number[]; ys: number[] } {
    const { w: W, h: H } = this.app.workspace.workspaceSize;
    const xs = [0, W, W / 2], ys = [0, H, H / 2];
    if (this.ws.mode !== 'freeform') {
      const gl = gridLines(this.ws.grid, W, H);
      xs.push(...gl.xs);
      ys.push(...gl.ys);
    }
    for (const m of this.app.workspace.moduleRects()) {
      if (exclude.has(m.id)) continue;
      xs.push(m.rect.x, m.rect.x + m.rect.w);
      ys.push(m.rect.y, m.rect.y + m.rect.h);
    }
    return { xs, ys };
  }

  private showGuides(g: { axis: 'x' | 'y'; pos: number }[]): void {
    this.guides.replaceChildren(...g.map((x) => h('div.guide', { class: x.axis, style: x.axis === 'x' ? `left:${x.pos}px` : `top:${x.pos}px` })));
  }

  private startMove(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    const ws = this.ws;
    const inst = ws.modules.find((m) => m.id === id);
    if (!inst) return;
    if (e.shiftKey) {
      if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    } else if (!this.selection.has(id)) {
      this.selection = new Set(groupMembers(ws, id));
    }
    for (const sid of [...this.selection]) for (const gm of groupMembers(ws, sid)) this.selection.add(gm);
    this.render();
    if (inst.layout.locked) return;
    const box = e.currentTarget as HTMLElement;
    box.setPointerCapture(e.pointerId);
    const { w: W, h: H } = this.app.workspace.workspaceSize;
    const start = { x: e.clientX, y: e.clientY };
    const docked = isDocked(ws, inst);
    const before = clone(ws);
    const rects = new Map(this.app.workspace.moduleRects().map((m) => [m.id, m.rect]));
    const primary = rects.get(id)!;
    const ids = [...this.selection];
    const snapOn = this.app.get<boolean>('interface.grid_snapping') && !e.altKey;
    const threshold = this.app.get<number>('interface.snap_threshold');
    const targets = this.snapTargets(new Set(ids));
    let delta = { x: 0, y: 0 };
    let cellTarget: { col: number; row: number } | null = null;
    const grabCell = pointToCell(ws.grid, start.x - this.layer.getBoundingClientRect().left, start.y - this.layer.getBoundingClientRect().top, W, H);
    this.dragging = true;
    const move = (ev: PointerEvent) => {
      let dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (docked) {
        const lr = this.layer.getBoundingClientRect();
        const cell = pointToCell(ws.grid, ev.clientX - lr.left, ev.clientY - lr.top, W, H);
        cellTarget = { col: Math.max(0, inst.layout.col + cell.col - grabCell.col), row: Math.max(0, inst.layout.row + cell.row - grabCell.row) };
        const r = gridCellRect(ws.grid, { ...inst.layout, ...cellTarget }, W, H);
        this.showGuides([]);
        box.style.left = `${r.x}px`;
        box.style.top = `${r.y}px`;
        return;
      }
      if (snapOn) {
        const s = snapRect({ ...primary, x: primary.x + dx, y: primary.y + dy }, targets, threshold);
        dx = s.rect.x - primary.x;
        dy = s.rect.y - primary.y;
        this.showGuides(s.guides);
      }
      delta = { x: dx, y: dy };
      for (const sid of ids) {
        const fr = this.app.workspace.frameOf(sid);
        const r = rects.get(sid);
        const m = ws.modules.find((x) => x.id === sid);
        if (!fr || !r || !m || m.layout.locked || isDocked(ws, m)) continue;
        fr.style.left = `${r.x + dx}px`;
        fr.style.top = `${r.y + dy}px`;
      }
      box.style.left = `${primary.x + dx}px`;
      box.style.top = `${primary.y + dy}px`;
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      this.dragging = false;
      this.showGuides([]);
      if (docked && cellTarget && (cellTarget.col !== inst.layout.col || cellTarget.row !== inst.layout.row)) {
        this.history.push(before);
        this.app.workspace.apply(setGridPlacement(before, id, { ...cellTarget, colSpan: inst.layout.colSpan, rowSpan: inst.layout.rowSpan }));
      } else if (!docked && (delta.x || delta.y)) {
        this.history.push(before);
        const floatIds = ids.filter((sid) => { const m = before.modules.find((x) => x.id === sid); return m && !isDocked(before, m); });
        this.app.workspace.apply(moveFloating(before, floatIds, delta.x / W, delta.y / H));
      }
      this.render();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up, { once: true });
  }

  private startResize(e: PointerEvent, id: string, edge: Edge): void {
    const ws = this.ws;
    const inst = ws.modules.find((m) => m.id === id);
    if (!inst || inst.layout.locked) return;
    this.selection = new Set([id]);
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const { w: W, h: H } = this.app.workspace.workspaceSize;
    const before = clone(ws);
    const r0 = this.app.workspace.moduleRects().find((m) => m.id === id)!.rect;
    const docked = isDocked(ws, inst);
    const start = { x: e.clientX, y: e.clientY };
    const snapOn = this.app.get<boolean>('interface.grid_snapping') && !e.altKey;
    const targets = this.snapTargets(new Set([id]));
    const threshold = this.app.get<number>('interface.snap_threshold');
    let rect: Rect = { ...r0 };
    this.dragging = true;
    const box = handle.parentElement!;
    const frame = this.app.workspace.frameOf(id);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      rect = { ...r0 };
      if (edge.left) { rect.x += dx; rect.w -= dx; }
      if (edge.right) rect.w += dx;
      if (edge.top) { rect.y += dy; rect.h -= dy; }
      if (edge.bottom) rect.h += dy;
      if (rect.w < 60) { if (edge.left) rect.x -= 60 - rect.w; rect.w = 60; }
      if (rect.h < 40) { if (edge.top) rect.y -= 40 - rect.h; rect.h = 40; }
      if (snapOn || docked) {
        const s = snapRect(rect, targets, docked ? 1e6 : threshold, edge);
        if (!docked) { rect = s.rect; this.showGuides(s.guides); }
      }
      for (const el of [box, frame]) {
        if (!el) continue;
        el.style.left = `${rect.x}px`; el.style.top = `${rect.y}px`; el.style.width = `${rect.w}px`; el.style.height = `${rect.h}px`;
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      this.dragging = false;
      this.showGuides([]);
      this.history.push(before);
      if (docked) {
        const a = pointToCell(ws.grid, rect.x + 4, rect.y + 4, W, H);
        const b = pointToCell(ws.grid, rect.x + rect.w - 4, rect.y + rect.h - 4, W, H);
        this.app.workspace.apply(setGridPlacement(before, id, { col: a.col, row: a.row, colSpan: b.col - a.col + 1, rowSpan: b.row - a.row + 1 }));
      } else {
        this.app.workspace.apply(setFloatingRect(before, id, { x: rect.x / W, y: rect.y / H, w: rect.w / W, h: rect.h / H }));
      }
      this.render();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  }

  // ───────────────────────── inspector ─────────────────────────

  private renderInspector(): void {
    const ids = [...this.selection];
    if (!ids.length) {
      this.inspector.replaceChildren(h('div.dim', 'Click a module to select (Shift-click for multiple). Drag to move, edges to resize, drag grid lines to resize tracks. Alt disables snapping. Drag modules in from the library.'));
      return;
    }
    const inst = this.ws.modules.find((m) => m.id === ids[0]);
    if (!inst) return;
    const L = inst.layout;
    const set = (fn: (m: ModuleInstance) => void) => this.commit(updateModule(this.ws, inst.id, fn));
    const btn = (label: string, title: string, fn: () => void, on = false) => h('button', { title, onclick: fn, class: on ? 'on' : '' }, label);
    const opacity = h('input', { type: 'range', min: '0.05', max: '1', step: '0.01', value: String(L.opacity), title: 'Opacity' });
    opacity.addEventListener('change', () => set((m) => (m.layout.opacity = Number(opacity.value))));
    opacity.addEventListener('input', () => { const fr = this.app.workspace.frameOf(inst.id); if (fr) fr.style.opacity = opacity.value; });
    const rot = h('input', { type: 'number', min: '-180', max: '180', step: '1', value: String(L.rotation), class: 'num', title: 'Rotation (floating modules)' });
    rot.addEventListener('change', () => set((m) => (m.layout.rotation = Math.max(-180, Math.min(180, Number(rot.value) || 0)))));
    const title = h('input', { value: inst.title ?? '', placeholder: 'title', spellcheck: 'false' });
    title.addEventListener('change', () => set((m) => (m.title = title.value.trim().slice(0, 80) || undefined)));
    this.inspector.replaceChildren(
      h('span.label', `${ids.length > 1 ? `${ids.length} SELECTED · ` : ''}${inst.type.toUpperCase()}`), title,
      btn('⚙', 'Module settings', () => this.app.overlays.openModuleSettings(inst.id)),
      btn('⧉', 'Duplicate', () => this.duplicateSelection()),
      btn('✕', 'Remove', () => void this.removeSelection()),
      btn('⤒', 'Bring to front', () => this.commit(reorder(this.ws, inst.id, 'front'))),
      btn('▲', 'Bring forward', () => this.commit(reorder(this.ws, inst.id, 'forward'))),
      btn('▼', 'Send backward', () => this.commit(reorder(this.ws, inst.id, 'backward'))),
      btn('⤓', 'Send to back', () => this.commit(reorder(this.ws, inst.id, 'back'))),
      btn(L.locked ? 'UNLOCK' : 'LOCK', 'Lock position and size', () => set((m) => (m.layout.locked = !m.layout.locked)), L.locked),
      btn(L.pinned ? 'UNPIN' : 'PIN', 'Pin above all floating modules', () => set((m) => (m.layout.pinned = !m.layout.pinned)), L.pinned),
      this.ws.mode === 'hybrid' ? btn(L.docked ? 'FLOAT' : 'DOCK', 'Toggle docked (grid) / floating', () => set((m) => {
        if (m.layout.docked) {
          const r = this.app.workspace.moduleRects().find((x) => x.id === m.id)!.rect;
          const { w: W, h: H } = this.app.workspace.workspaceSize;
          Object.assign(m.layout, { docked: false, x: r.x / W + 0.01, y: r.y / H + 0.01, w: r.w / W, h: r.h / H });
        } else m.layout.docked = true;
      })) : '',
      btn(inst.hidden ? 'SHOW' : 'HIDE', 'Hide without removing', () => set((m) => (m.hidden = !m.hidden))),
      h('label.tb-num', h('span.label', 'OPACITY'), opacity),
      h('label.tb-num', h('span.label', 'ROT°'), rot),
    );
  }
}

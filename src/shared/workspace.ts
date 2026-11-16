/**
 * Workspace model and pure layout operations.
 *
 * A module instance stores BOTH a grid placement and a floating placement.
 * The workspace mode decides which is used:
 *   grid     → every module uses its grid cell
 *   freeform → every module floats
 *   hybrid   → each module's `docked` flag decides
 * so switching modes is non-destructive.
 *
 * Floating rectangles are stored as fractions (0..1) of the workspace so a
 * layout scales with the window.
 */
import { z } from 'zod';
import { ThemeOverrideSchema, type ThemeOverride } from './theme';

export const LAYOUT_MODES = ['grid', 'freeform', 'hybrid'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

const idRe = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const ModuleLayoutSchema = z.object({
  docked: z.boolean().default(true),
  col: z.number().int().min(0).max(63).default(0),
  row: z.number().int().min(0).max(63).default(0),
  colSpan: z.number().int().min(1).max(64).default(1),
  rowSpan: z.number().int().min(1).max(64).default(1),
  x: z.number().min(-1).max(2).default(0.3),
  y: z.number().min(-1).max(2).default(0.3),
  w: z.number().min(0.02).max(2).default(0.3),
  h: z.number().min(0.02).max(2).default(0.3),
  z: z.number().int().min(0).max(10000).default(1),
  opacity: z.number().min(0.05).max(1).default(1),
  rotation: z.number().min(-180).max(180).default(0),
  locked: z.boolean().default(false),
  pinned: z.boolean().default(false),
  group: z.string().max(64).optional(),
});
export type ModuleLayout = z.infer<typeof ModuleLayoutSchema>;

export const ModuleInstanceSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.string().regex(idRe),
  title: z.string().max(80).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  layout: ModuleLayoutSchema,
  style: ThemeOverrideSchema.optional(),
  hidden: z.boolean().optional(),
});
export type ModuleInstance = z.infer<typeof ModuleInstanceSchema>;

export const GridSpecSchema = z.object({
  cols: z.number().int().min(1).max(64),
  rows: z.number().int().min(1).max(64),
  gap: z.number().min(0).max(64).default(6),
  colSizes: z.array(z.number().min(0.05).max(100)).default([]),
  rowSizes: z.array(z.number().min(0.05).max(100)).default([]),
});
export type GridSpec = z.infer<typeof GridSpecSchema>;

export const WorkspaceSchema = z.object({
  format: z.literal(1).default(1),
  id: z.string().regex(idRe),
  name: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
  mode: z.enum(LAYOUT_MODES),
  grid: GridSpecSchema,
  modules: z.array(ModuleInstanceSchema).max(128),
  /** Workspace-specific theme (falls back to the global theme). */
  theme: z.string().regex(idRe).optional(),
  themeOverride: ThemeOverrideSchema.optional(),
  /** Workspace-specific performance profile. */
  performance: z.enum(['eco', 'balanced', 'high', 'cinematic', 'adaptive']).optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export interface Rect { x: number; y: number; w: number; h: number }

// ───────────────────────────── helpers ─────────────────────────────

let idCounter = 0;
export function newModuleId(type: string): string {
  idCounter = (idCounter + 1) % 1e6;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${type.replace(/[^a-z0-9]/g, '').slice(0, 12)}-${Date.now().toString(36)}${rand}${idCounter.toString(36)}`;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function isDocked(ws: Workspace, m: ModuleInstance): boolean {
  if (ws.mode === 'grid') return true;
  if (ws.mode === 'freeform') return false;
  return m.layout.docked;
}

export function gridSizes(spec: GridSpec): { cols: number[]; rows: number[] } {
  const cols = Array.from({ length: spec.cols }, (_, i) => spec.colSizes[i] ?? 1);
  const rows = Array.from({ length: spec.rows }, (_, i) => spec.rowSizes[i] ?? 1);
  return { cols, rows };
}

/** Pixel rectangle of a grid placement inside a workspace of size (W,H). */
export function gridCellRect(spec: GridSpec, l: Pick<ModuleLayout, 'col' | 'row' | 'colSpan' | 'rowSpan'>, W: number, H: number): Rect {
  const { cols, rows } = gridSizes(spec);
  const totalC = cols.reduce((a, b) => a + b, 0);
  const totalR = rows.reduce((a, b) => a + b, 0);
  const g = spec.gap;
  const usableW = W - g * (cols.length + 1);
  const usableH = H - g * (rows.length + 1);
  const xs = [g];
  for (let i = 0; i < cols.length; i++) xs.push(xs[i] + (cols[i] / totalC) * usableW + g);
  const ys = [g];
  for (let i = 0; i < rows.length; i++) ys.push(ys[i] + (rows[i] / totalR) * usableH + g);
  const c0 = Math.min(l.col, cols.length - 1);
  const r0 = Math.min(l.row, rows.length - 1);
  const c1 = Math.min(c0 + l.colSpan, cols.length);
  const r1 = Math.min(r0 + l.rowSpan, rows.length);
  return { x: xs[c0], y: ys[r0], w: xs[c1] - xs[c0] - g, h: ys[r1] - ys[r0] - g };
}

/** Grid line positions in pixels (for drawing the editor overlay and snapping). */
export function gridLines(spec: GridSpec, W: number, H: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let c = 0; c <= spec.cols; c++) xs.push(c === spec.cols ? W - spec.gap / 2 : gridCellRect(spec, { col: c, row: 0, colSpan: 1, rowSpan: 1 }, W, H).x - spec.gap / 2);
  for (let r = 0; r <= spec.rows; r++) ys.push(r === spec.rows ? H - spec.gap / 2 : gridCellRect(spec, { col: 0, row: r, colSpan: 1, rowSpan: 1 }, W, H).y - spec.gap / 2);
  return { xs, ys };
}

/** Convert a pixel point to the grid cell containing it. */
export function pointToCell(spec: GridSpec, px: number, py: number, W: number, H: number): { col: number; row: number } {
  const { xs, ys } = gridLines(spec, W, H);
  let col = spec.cols - 1;
  for (let i = 0; i < spec.cols; i++) if (px < xs[i + 1]) { col = i; break; }
  let row = spec.rows - 1;
  for (let i = 0; i < spec.rows; i++) if (py < ys[i + 1]) { row = i; break; }
  return { col: Math.max(0, col), row: Math.max(0, row) };
}

/** Find the first free grid area of the given span (row-major), or null. */
export function findFreeCell(ws: Workspace, colSpan: number, rowSpan: number): { col: number; row: number } | null {
  const occ = new Set<string>();
  for (const m of ws.modules) {
    if (!isDocked(ws, m) || m.hidden) continue;
    for (let c = m.layout.col; c < m.layout.col + m.layout.colSpan; c++) for (let r = m.layout.row; r < m.layout.row + m.layout.rowSpan; r++) occ.add(`${c},${r}`);
  }
  for (let r = 0; r + rowSpan <= ws.grid.rows; r++) {
    for (let c = 0; c + colSpan <= ws.grid.cols; c++) {
      let free = true;
      for (let dc = 0; dc < colSpan && free; dc++) for (let dr = 0; dr < rowSpan && free; dr++) if (occ.has(`${c + dc},${r + dr}`)) free = false;
      if (free) return { col: c, row: r };
    }
  }
  return null;
}

function maxZ(ws: Workspace): number {
  return ws.modules.reduce((a, m) => Math.max(a, m.layout.z), 0);
}

// ───────────────────────────── operations ─────────────────────────────

export interface AddOptions {
  config?: Record<string, unknown>;
  title?: string;
  /** Floating rect (fractions). */
  rect?: Rect;
  /** Preferred grid cell. */
  cell?: { col: number; row: number; colSpan?: number; rowSpan?: number };
  docked?: boolean;
  defaultSize?: { colSpan: number; rowSpan: number; w: number; h: number };
}

export function addModule(ws: Workspace, type: string, opts: AddOptions = {}): { ws: Workspace; id: string } {
  const next = clone(ws);
  const id = newModuleId(type);
  const size = opts.defaultSize ?? { colSpan: 1, rowSpan: 1, w: 0.25, h: 0.25 };
  const colSpan = Math.min(opts.cell?.colSpan ?? size.colSpan, ws.grid.cols);
  const rowSpan = Math.min(opts.cell?.rowSpan ?? size.rowSpan, ws.grid.rows);
  const cell = opts.cell ?? findFreeCell(ws, colSpan, rowSpan) ?? { col: 0, row: 0 };
  const rect = opts.rect ?? { x: 0.5 - size.w / 2 + (ws.modules.length % 5) * 0.02, y: 0.5 - size.h / 2 + (ws.modules.length % 5) * 0.02, w: size.w, h: size.h };
  const docked = opts.docked ?? (ws.mode === 'freeform' ? false : ws.mode === 'grid' ? true : !opts.rect);
  next.modules.push({
    id,
    type,
    title: opts.title,
    config: opts.config ?? {},
    layout: ModuleLayoutSchema.parse({
      docked,
      col: clampInt(cell.col, 0, ws.grid.cols - 1),
      row: clampInt(cell.row, 0, ws.grid.rows - 1),
      colSpan, rowSpan,
      ...clampRect(rect),
      z: maxZ(ws) + 1,
    }),
  });
  return { ws: next, id };
}

export function removeModules(ws: Workspace, ids: string[]): Workspace {
  const set = new Set(ids);
  return { ...clone(ws), modules: ws.modules.filter((m) => !set.has(m.id)).map((m) => clone(m)) };
}

export function duplicateModules(ws: Workspace, ids: string[]): { ws: Workspace; newIds: string[] } {
  let next = clone(ws);
  const newIds: string[] = [];
  const groupMap = new Map<string, string>();
  for (const id of ids) {
    const src = ws.modules.find((m) => m.id === id);
    if (!src) continue;
    const copy = clone(src);
    copy.id = newModuleId(src.type);
    copy.layout.x = Math.min(copy.layout.x + 0.02, 1 - copy.layout.w);
    copy.layout.y = Math.min(copy.layout.y + 0.02, 1 - copy.layout.h);
    copy.layout.z = maxZ(next) + 1;
    copy.layout.locked = false;
    if (copy.layout.group) {
      if (!groupMap.has(copy.layout.group)) groupMap.set(copy.layout.group, `g-${newModuleId('grp')}`);
      copy.layout.group = groupMap.get(copy.layout.group);
    }
    // A docked duplicate floats in hybrid mode so it does not overlap its source cell.
    if (next.mode === 'hybrid' && copy.layout.docked) {
      copy.layout.docked = false;
    } else if (next.mode === 'grid') {
      const free = findFreeCell(next, copy.layout.colSpan, copy.layout.rowSpan);
      if (free) Object.assign(copy.layout, free);
    }
    next.modules.push(copy);
    newIds.push(copy.id);
    next = clone(next);
  }
  return { ws: next, newIds };
}

export function updateModule(ws: Workspace, id: string, fn: (m: ModuleInstance) => void): Workspace {
  const next = clone(ws);
  const m = next.modules.find((x) => x.id === id);
  if (m) fn(m);
  return next;
}

/** Modules that move together with `id` (same group), including itself. */
export function groupMembers(ws: Workspace, id: string): string[] {
  const m = ws.modules.find((x) => x.id === id);
  if (!m) return [];
  if (!m.layout.group) return [id];
  return ws.modules.filter((x) => x.layout.group === m.layout.group).map((x) => x.id);
}

export function moveFloating(ws: Workspace, ids: string[], dx: number, dy: number): Workspace {
  const next = clone(ws);
  for (const m of next.modules) {
    if (!ids.includes(m.id) || m.layout.locked) continue;
    m.layout.x = clamp(m.layout.x + dx, -0.5, 1.5 - m.layout.w * 0.1);
    m.layout.y = clamp(m.layout.y + dy, -0.5, 1.5 - m.layout.h * 0.1);
  }
  return next;
}

export function setFloatingRect(ws: Workspace, id: string, rect: Rect): Workspace {
  return updateModule(ws, id, (m) => {
    if (m.layout.locked) return;
    Object.assign(m.layout, clampRect(rect));
  });
}

export function setGridPlacement(ws: Workspace, id: string, p: { col: number; row: number; colSpan: number; rowSpan: number }): Workspace {
  return updateModule(ws, id, (m) => {
    if (m.layout.locked) return;
    const col = clampInt(p.col, 0, ws.grid.cols - 1);
    const row = clampInt(p.row, 0, ws.grid.rows - 1);
    m.layout.col = col;
    m.layout.row = row;
    m.layout.colSpan = clampInt(p.colSpan, 1, ws.grid.cols - col);
    m.layout.rowSpan = clampInt(p.rowSpan, 1, ws.grid.rows - row);
  });
}

export type ZOp = 'front' | 'back' | 'forward' | 'backward';
export function reorder(ws: Workspace, id: string, op: ZOp): Workspace {
  const next = clone(ws);
  const sorted = [...next.modules].sort((a, b) => a.layout.z - b.layout.z);
  const i = sorted.findIndex((m) => m.id === id);
  if (i < 0) return next;
  const [m] = sorted.splice(i, 1);
  const target = op === 'front' ? sorted.length : op === 'back' ? 0 : op === 'forward' ? Math.min(i + 1, sorted.length) : Math.max(i - 1, 0);
  sorted.splice(target, 0, m);
  sorted.forEach((mod, idx) => (mod.layout.z = idx + 1));
  return next;
}

export function groupModules(ws: Workspace, ids: string[]): Workspace {
  if (ids.length < 2) return clone(ws);
  const gid = `g-${newModuleId('grp')}`;
  const next = clone(ws);
  for (const m of next.modules) if (ids.includes(m.id)) m.layout.group = gid;
  return next;
}

export function ungroupModules(ws: Workspace, ids: string[]): Workspace {
  const next = clone(ws);
  const groups = new Set(next.modules.filter((m) => ids.includes(m.id)).map((m) => m.layout.group).filter(Boolean));
  for (const m of next.modules) if (m.layout.group && groups.has(m.layout.group)) delete m.layout.group;
  return next;
}

export function setGridSpec(ws: Workspace, spec: Partial<GridSpec>): Workspace {
  const next = clone(ws);
  next.grid = GridSpecSchema.parse({ ...next.grid, ...spec });
  for (const m of next.modules) {
    m.layout.col = Math.min(m.layout.col, next.grid.cols - 1);
    m.layout.row = Math.min(m.layout.row, next.grid.rows - 1);
    m.layout.colSpan = clampInt(m.layout.colSpan, 1, next.grid.cols - m.layout.col);
    m.layout.rowSpan = clampInt(m.layout.rowSpan, 1, next.grid.rows - m.layout.row);
  }
  return next;
}

/** Resize the track (column or row) boundary at `index` by moving it `deltaFraction` of the total. */
export function resizeTrack(ws: Workspace, axis: 'col' | 'row', index: number, deltaFraction: number): Workspace {
  const next = clone(ws);
  const { cols, rows } = gridSizes(next.grid);
  const sizes = axis === 'col' ? cols : rows;
  if (index < 0 || index >= sizes.length - 1) return next;
  const total = sizes.reduce((a, b2) => a + b2, 0);
  const delta = deltaFraction * total;
  const minSize = total * 0.02;
  const a = sizes[index] + delta;
  const bb = sizes[index + 1] - delta;
  if (a < minSize || bb < minSize) return next;
  sizes[index] = a;
  sizes[index + 1] = bb;
  const rounded = sizes.map((v) => Math.round(v * 1000) / 1000);
  if (axis === 'col') next.grid.colSizes = rounded;
  else next.grid.rowSizes = rounded;
  return next;
}

// ───────────────────────────── snapping ─────────────────────────────

export interface SnapResult { rect: Rect; guides: { axis: 'x' | 'y'; pos: number }[] }

/**
 * Snap a pixel rectangle's edges (and centre) to grid lines and to edges of
 * other rectangles, within `threshold` pixels. When `resizing` is set only the
 * moving edges are snapped.
 */
export function snapRect(rect: Rect, targets: { xs: number[]; ys: number[] }, threshold: number, resizing?: { left: boolean; right: boolean; top: boolean; bottom: boolean }): SnapResult {
  const guides: SnapResult['guides'] = [];
  const out = { ...rect };
  const best = (vals: number[], cands: number[]) => {
    let bestD = threshold + 1;
    let bestShift = 0;
    let bestPos = 0;
    for (const v of vals) for (const c of cands) {
      const d = Math.abs(c - v);
      if (d < bestD) { bestD = d; bestShift = c - v; bestPos = c; }
    }
    return bestD <= threshold ? { shift: bestShift, pos: bestPos } : null;
  };
  if (!resizing) {
    const sx = best([rect.x, rect.x + rect.w, rect.x + rect.w / 2], targets.xs);
    if (sx) { out.x += sx.shift; guides.push({ axis: 'x', pos: sx.pos }); }
    const sy = best([rect.y, rect.y + rect.h, rect.y + rect.h / 2], targets.ys);
    if (sy) { out.y += sy.shift; guides.push({ axis: 'y', pos: sy.pos }); }
  } else {
    if (resizing.left) { const s = best([rect.x], targets.xs); if (s) { out.x += s.shift; out.w -= s.shift; guides.push({ axis: 'x', pos: s.pos }); } }
    if (resizing.right) { const s = best([rect.x + rect.w], targets.xs); if (s) { out.w += s.shift; guides.push({ axis: 'x', pos: s.pos }); } }
    if (resizing.top) { const s = best([rect.y], targets.ys); if (s) { out.y += s.shift; out.h -= s.shift; guides.push({ axis: 'y', pos: s.pos }); } }
    if (resizing.bottom) { const s = best([rect.y + rect.h], targets.ys); if (s) { out.h += s.shift; guides.push({ axis: 'y', pos: s.pos }); } }
  }
  return { rect: out, guides };
}

// ───────────────────────────── history ─────────────────────────────

/** Snapshot-based undo/redo history. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private limit = 100) {}
  push(state: T): void {
    this.past.push(clone(state));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(clone(current));
    return prev;
  }
  redo(current: T): T | null {
    const nxt = this.future.pop();
    if (nxt === undefined) return null;
    this.past.push(clone(current));
    return nxt;
  }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.past = []; this.future = []; }
}

// ───────────────────────────── misc ─────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, Math.max(lo, hi)));
}
function clampRect(r: Rect): Rect {
  const w = clamp(r.w, 0.02, 2);
  const h = clamp(r.h, 0.02, 2);
  return { x: clamp(r.x, -1, 2), y: clamp(r.y, -1, 2), w, h };
}

export function validateWorkspace(raw: unknown): { ok: true; ws: Workspace } | { ok: false; error: string } {
  const r = WorkspaceSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 6).join('; ') };
  // Drop duplicate module ids defensively.
  const seen = new Set<string>();
  r.data.modules = r.data.modules.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  return { ok: true, ws: r.data };
}

export type { ThemeOverride };

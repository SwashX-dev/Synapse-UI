import { describe, expect, it } from 'vitest';
import {
  History, addModule, duplicateModules, findFreeCell, gridCellRect, groupMembers, groupModules, moveFloating, pointToCell, removeModules, reorder, resizeTrack,
  setFloatingRect, setGridPlacement, snapRect, ungroupModules, validateWorkspace, type Workspace,
} from '../../src/shared/workspace';
import { BUILTIN_WORKSPACES } from '../../src/shared/profiles';

const blank = (): Workspace => ({ format: 1, id: 't', name: 'T', description: '', mode: 'hybrid', grid: { cols: 4, rows: 4, gap: 0, colSizes: [], rowSizes: [] }, modules: [] });

describe('workspace model', () => {
  it('validates every built-in profile', () => {
    for (const ws of BUILTIN_WORKSPACES) {
      const r = validateWorkspace(ws);
      expect(r.ok, `${ws.id}: ${!r.ok ? r.error : ''}`).toBe(true);
    }
    expect(BUILTIN_WORKSPACES.map((w) => w.id)).toEqual(['classic-edex', 'neural-lab', 'cyber-sec', 'scientific', 'cinematic', 'custom']);
  });

  it('adds modules into free grid cells and floating rects', () => {
    let ws = blank();
    const a = addModule(ws, 'cpu', { defaultSize: { colSpan: 2, rowSpan: 2, w: 0.2, h: 0.2 }, docked: true });
    ws = a.ws;
    expect(ws.modules[0].layout).toMatchObject({ col: 0, row: 0, colSpan: 2, rowSpan: 2, docked: true });
    const b = addModule(ws, 'memory', { defaultSize: { colSpan: 2, rowSpan: 2, w: 0.2, h: 0.2 }, docked: true });
    expect(b.ws.modules[1].layout).toMatchObject({ col: 2, row: 0 });
    expect(findFreeCell(b.ws, 4, 4)).toBeNull();
    const c = addModule(b.ws, 'clock', { rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } });
    expect(c.ws.modules[2].layout.docked).toBe(false);
    expect(c.ws.modules[2].layout.z).toBeGreaterThan(b.ws.modules[1].layout.z);
  });

  it('drags, resizes, duplicates, deletes and reorders', () => {
    let ws = blank();
    ws = addModule(ws, 'a', { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }).ws;
    ws = addModule(ws, 'b', { rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }).ws;
    const [a, b] = ws.modules.map((m) => m.id);
    ws = moveFloating(ws, [a], 0.1, 0.05);
    expect(ws.modules[0].layout.x).toBeCloseTo(0.2);
    expect(ws.modules[0].layout.y).toBeCloseTo(0.15);
    ws = setFloatingRect(ws, b, { x: 0.4, y: 0.4, w: 0.5, h: 0.3 });
    expect(ws.modules[1].layout.w).toBeCloseTo(0.5);
    const dup = duplicateModules(ws, [b]);
    expect(dup.ws.modules).toHaveLength(3);
    expect(dup.newIds[0]).not.toBe(b);
    ws = reorder(dup.ws, a, 'front');
    expect(ws.modules.find((m) => m.id === a)!.layout.z).toBe(Math.max(...ws.modules.map((m) => m.layout.z)));
    ws = removeModules(ws, [b]);
    expect(ws.modules.map((m) => m.id)).not.toContain(b);
  });

  it('honours locks and clamps grid placement', () => {
    let ws = addModule(blank(), 'a', { docked: true }).ws;
    const id = ws.modules[0].id;
    ws = setGridPlacement(ws, id, { col: 3, row: 3, colSpan: 5, rowSpan: 5 });
    expect(ws.modules[0].layout).toMatchObject({ col: 3, row: 3, colSpan: 1, rowSpan: 1 });
    ws.modules[0].layout.locked = true;
    const moved = setGridPlacement(ws, id, { col: 0, row: 0, colSpan: 1, rowSpan: 1 });
    expect(moved.modules[0].layout.col).toBe(3);
  });

  it('groups modules so they move together', () => {
    let ws = blank();
    ws = addModule(ws, 'a', { rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }).ws;
    ws = addModule(ws, 'b', { rect: { x: 0.3, y: 0.1, w: 0.1, h: 0.1 } }).ws;
    const ids = ws.modules.map((m) => m.id);
    ws = groupModules(ws, ids);
    expect(groupMembers(ws, ids[0]).sort()).toEqual([...ids].sort());
    ws = ungroupModules(ws, [ids[0]]);
    expect(groupMembers(ws, ids[0])).toEqual([ids[0]]);
  });

  it('computes grid geometry, resizes tracks and maps points to cells', () => {
    const ws = blank();
    ws.grid.gap = 10;
    const r = gridCellRect(ws.grid, { col: 1, row: 1, colSpan: 2, rowSpan: 1 }, 1010, 410);
    expect(r).toEqual({ x: 260, y: 110, w: 490, h: 90 });
    expect(pointToCell(ws.grid, 300, 150, 1010, 410)).toEqual({ col: 1, row: 1 });
    const resized = resizeTrack(ws, 'col', 0, 0.1);
    expect(resized.grid.colSizes[0]).toBeCloseTo(1.4);
    expect(resized.grid.colSizes[1]).toBeCloseTo(0.6);
  });

  it('snaps edges within the threshold', () => {
    const s = snapRect({ x: 103, y: 50, w: 100, h: 100 }, { xs: [100], ys: [] }, 6);
    expect(s.rect.x).toBe(100);
    expect(s.guides[0]).toEqual({ axis: 'x', pos: 100 });
    expect(snapRect({ x: 120, y: 50, w: 100, h: 100 }, { xs: [100], ys: [] }, 6).rect.x).toBe(120);
  });

  it('provides undo/redo', () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.canUndo).toBe(true);
  });

  it('rejects malformed workspace files', () => {
    expect(validateWorkspace({ id: 'x' }).ok).toBe(false);
    expect(validateWorkspace({ ...blank(), modules: [{ id: '../evil', type: 'cpu', config: {}, layout: {} }] }).ok).toBe(false);
    expect(validateWorkspace({ ...blank(), id: 'Bad ID!' }).ok).toBe(false);
  });
});

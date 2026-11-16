import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_THEMES, ThemeSchema, applyOverride, convertLegacyEdexTheme, themeCssVars } from '../../src/shared/theme';
import { parseCsv, parseJsonData, stats } from '../../src/shared/data';
import { Rng, parseSeed } from '../../src/shared/random';

describe('themes', () => {
  it('ships the eight required themes, all valid', () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(['obsidian', 'edex-classic', 'crimson-protocol', 'cybernetic-blue', 'terminal-green', 'ultraviolet', 'ghost-white', 'custom']);
    for (const t of BUILTIN_THEMES) expect(ThemeSchema.safeParse(t).success, t.id).toBe(true);
  });
  it('coordinates more than one accent color per theme', () => {
    for (const t of BUILTIN_THEMES.filter((x) => x.id !== 'custom')) {
      const distinct = new Set([t.colors.background, t.colors.foreground, t.colors.text, t.colors.border, t.colors.neural, t.terminal.background]);
      expect(distinct.size, t.id).toBeGreaterThanOrEqual(t.id === "edex-classic" ? 3 : 4);
      expect(Object.keys(themeCssVars(t)).length).toBeGreaterThan(40);
    }
  });
  it('converts every original eDEX-UI theme', () => {
    const dir = path.resolve(__dirname, '../../src/assets/themes');
    for (const f of fs.readdirSync(dir)) {
      const t = convertLegacyEdexTheme(`edex-${f.replace('.json', '')}`, f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      expect(ThemeSchema.safeParse(t).success, f).toBe(true);
    }
  });
  it('applies partial overrides', () => {
    const t = applyOverride(BUILTIN_THEMES[0], { colors: { accent: '#123456' }, effects: { border_width: 3 } });
    expect(t.colors.accent).toBe('#123456');
    expect(t.effects.border_width).toBe(3);
    expect(t.colors.background).toBe(BUILTIN_THEMES[0].colors.background);
  });
});

describe('data ingestion', () => {
  it('parses CSV with headers, quotes and mixed delimiters', () => {
    const ds = parseCsv('time;cpu;"label, x"\n1;10.5;"a ""b"""\n2;11;c\n');
    expect(ds.columns).toEqual(['time', 'cpu', 'label_x']);
    expect(Array.from(ds.series.cpu)).toEqual([10.5, 11]);
    expect(Number.isNaN(ds.series.label_x[0])).toBe(true);
  });
  it('parses JSON arrays and objects', () => {
    expect(parseJsonData('[1,2,3]').series.value.length).toBe(3);
    const o = parseJsonData('{"data":[{"t":1,"v":5},{"t":2,"v":7}]}');
    expect(Array.from(o.series.v)).toEqual([5, 7]);
    expect(stats(o.series.v)).toMatchObject({ min: 5, max: 7, mean: 6 });
    expect(() => parseJsonData('"nope"')).toThrow();
  });
});

describe('seeded randomness', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(c.next()).not.toBe(xs[0]);
    expect(parseSeed('0x539')).toBe(1337);
    expect(parseSeed('neural')).toBe(parseSeed('neural'));
  });
});

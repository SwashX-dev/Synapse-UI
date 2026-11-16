/**
 * Structured data ingestion for the data-visualization interface.
 * CSV and JSON files become named numeric series that modules can bind to.
 */

export interface Dataset {
  name: string;
  columns: string[];
  /** Column-major numeric data; NaN for non-numeric cells. */
  series: Record<string, Float64Array>;
  rows: number;
}

const MAX_ROWS = 200_000;
const MAX_COLS = 256;

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF), auto-detects , ; or tab. */
export function parseCsv(text: string, name = 'data.csv'): Dataset {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  if (rows.length === 0) return { name, columns: [], series: {}, rows: 0 };
  const header = rows[0];
  const headerIsText = header.some((h) => h.trim() !== '' && Number.isNaN(Number(h)));
  const columns = (headerIsText ? header : header.map((_, i) => `col${i + 1}`)).slice(0, MAX_COLS).map((c, i) => sanitizeName(c) || `col${i + 1}`);
  const body = headerIsText ? rows.slice(1) : rows;
  return build(name, uniq(columns), body.map((r) => r.slice(0, columns.length).map(toNum)));
}

/**
 * JSON: accepts an array of numbers, an array of objects ({t:1, cpu:4}),
 * an object of arrays ({cpu:[...], mem:[...]}), or {data: <any of those>}.
 */
export function parseJsonData(text: string, name = 'data.json'): Dataset {
  let v: unknown = JSON.parse(text);
  if (v && typeof v === 'object' && !Array.isArray(v) && 'data' in (v as object)) v = (v as { data: unknown }).data;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'number')) return build(name, ['value'], (v as number[]).slice(0, MAX_ROWS).map((x) => [x]));
    if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const cols: string[] = [];
      for (const o of v.slice(0, 1000) as Record<string, unknown>[]) for (const k of Object.keys(o)) if (!cols.includes(k) && cols.length < MAX_COLS) cols.push(k);
      return build(name, uniq(cols.map((c) => sanitizeName(c) || 'col')), (v as Record<string, unknown>[]).slice(0, MAX_ROWS).map((o) => cols.map((c) => toNum(o[c]))));
    }
    if (v.every((x) => Array.isArray(x))) {
      const width = Math.min(MAX_COLS, Math.max(...(v as unknown[][]).map((r) => r.length)));
      return build(name, Array.from({ length: width }, (_, i) => `col${i + 1}`), (v as unknown[][]).slice(0, MAX_ROWS).map((r) => Array.from({ length: width }, (_, i) => toNum(r[i]))));
    }
  } else if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, a]) => Array.isArray(a)).slice(0, MAX_COLS) as [string, unknown[]][];
    const len = Math.min(MAX_ROWS, Math.max(0, ...entries.map(([, a]) => a.length)));
    return build(name, uniq(entries.map(([k]) => sanitizeName(k) || 'col')), Array.from({ length: len }, (_, i) => entries.map(([, a]) => toNum(a[i]))));
  }
  throw new Error('unsupported JSON shape: expected numbers, an array of objects, or an object of arrays');
}

function toNum(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') {
    const s = x.trim();
    if (s === '') return NaN;
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
    const d = Date.parse(s);
    return Number.isNaN(d) ? NaN : d / 1000;
  }
  return NaN;
}

function sanitizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

function uniq(cols: string[]): string[] {
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n ? `${c}_${n + 1}` : c;
  });
}

function build(name: string, columns: string[], rows: number[][]): Dataset {
  const series: Record<string, Float64Array> = {};
  columns.forEach((c, j) => {
    const arr = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) arr[i] = rows[i][j] ?? NaN;
    series[c] = arr;
  });
  return { name, columns, series, rows: rows.length };
}

/** Basic statistics used for auto-ranging bindings. */
export function stats(a: Float64Array): { min: number; max: number; mean: number; count: number } {
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (const v of a) if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); sum += v; count++; }
  return count ? { min, max, mean: sum / count, count } : { min: 0, max: 1, mean: 0, count: 0 };
}

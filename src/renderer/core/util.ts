/** DOM and formatting helpers shared by renderer code. */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)> & { class?: string; style?: string };

/** Minimal hyperscript: h('div.cls#id', {attrs}, ...children). Text is always escaped. */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const m = sel.match(/^([a-z0-9-]+)((?:[.#][A-Za-z0-9_-]+)*)$/);
  const tag = (m?.[1] ?? 'div') as K;
  const el = document.createElement(tag);
  for (const part of (m?.[2] ?? '').match(/[.#][A-Za-z0-9_-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node)) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatRate(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return formatBytes(n) + '/s';
}

export function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function fmt(n: number | null | undefined, digits = 1, unit = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits) + unit;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const f = ((...a: A) => {
    last = a;
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; if (last) fn(...last); }, ms);
  }) as ((...a: A) => void) & { flush(): void; cancel(): void };
  f.flush = () => { if (t) { clearTimeout(t); t = null; if (last) fn(...last); } };
  f.cancel = () => { if (t) clearTimeout(t); t = null; };
  return f;
}

/** Fixed-capacity ring buffer of numbers (monitor history). */
export class Ring {
  readonly data: Float32Array;
  private head = 0;
  count = 0;
  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }
  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  /** i = 0 is the oldest retained sample. */
  at(i: number): number {
    return this.data[(this.head - this.count + i + this.capacity * 2) % this.capacity];
  }
  last(): number {
    return this.count ? this.at(this.count - 1) : 0;
  }
  max(): number {
    let m = -Infinity;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.at(i));
    return this.count ? m : 0;
  }
}

export class Emitter<E extends Record<string, unknown[]>> {
  private map = new Map<keyof E, Set<(...a: never[]) => void>>();
  on<K extends keyof E>(ev: K, fn: (...a: E[K]) => void): () => void {
    let s = this.map.get(ev);
    if (!s) { s = new Set(); this.map.set(ev, s); }
    s.add(fn as unknown as (...a: never[]) => void);
    return () => s!.delete(fn as unknown as (...a: never[]) => void);
  }
  emit<K extends keyof E>(ev: K, ...args: E[K]): void {
    for (const fn of this.map.get(ev) ?? []) {
      try { (fn as unknown as (...a: E[K]) => void)(...args); } catch (e) { console.error(e); }
    }
  }
}

export function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function uid(prefix = 'x'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Size a canvas's backing store to its CSS size × devicePixelRatio. Returns true if it changed. */
export function fitCanvas(c: HTMLCanvasElement, scale = 1): boolean {
  const dpr = (window.devicePixelRatio || 1) * scale;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const hh = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; return true; }
  return false;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q) + q.length * 2;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak * 2;
    ti = idx + 1;
  }
  return score;
}

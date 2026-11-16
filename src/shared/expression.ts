/**
 * Safe mathematical expression language for parameter automation and data
 * mappings, e.g. `0.5 + 0.4*sin(t*2)` or `clamp(cpu.load/100, 0, 1)*audio.bass`.
 *
 * Expressions are parsed into a closure tree. Nothing is ever passed to
 * `eval`/`Function`, there is no property access or object construction, and
 * only the whitelisted functions/constants below exist — so a malicious preset
 * or config file cannot execute code through an expression.
 */

export type Scope = (name: string) => number | undefined;
export type Compiled = (scope: Scope) => number;

const MAX_LENGTH = 1024;
const MAX_DEPTH = 64;

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
const noise1 = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
};

export const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number; doc: string }> = {
  sin: { arity: [1, 1], fn: Math.sin, doc: 'sine' },
  cos: { arity: [1, 1], fn: Math.cos, doc: 'cosine' },
  tan: { arity: [1, 1], fn: Math.tan, doc: 'tangent' },
  asin: { arity: [1, 1], fn: Math.asin, doc: 'arc sine' },
  acos: { arity: [1, 1], fn: Math.acos, doc: 'arc cosine' },
  atan: { arity: [1, 1], fn: Math.atan, doc: 'arc tangent' },
  atan2: { arity: [2, 2], fn: Math.atan2, doc: 'atan2(y, x)' },
  abs: { arity: [1, 1], fn: Math.abs, doc: 'absolute value' },
  sqrt: { arity: [1, 1], fn: (x) => Math.sqrt(Math.max(0, x)), doc: 'square root (clamped at 0)' },
  exp: { arity: [1, 1], fn: Math.exp, doc: 'e^x' },
  log: { arity: [1, 1], fn: (x) => Math.log(Math.max(1e-12, x)), doc: 'natural log' },
  log2: { arity: [1, 1], fn: (x) => Math.log2(Math.max(1e-12, x)), doc: 'log base 2' },
  log10: { arity: [1, 1], fn: (x) => Math.log10(Math.max(1e-12, x)), doc: 'log base 10' },
  pow: { arity: [2, 2], fn: Math.pow, doc: 'pow(x, y)' },
  min: { arity: [1, 16], fn: Math.min, doc: 'minimum' },
  max: { arity: [1, 16], fn: Math.max, doc: 'maximum' },
  floor: { arity: [1, 1], fn: Math.floor, doc: 'round down' },
  ceil: { arity: [1, 1], fn: Math.ceil, doc: 'round up' },
  round: { arity: [1, 1], fn: Math.round, doc: 'round' },
  fract: { arity: [1, 1], fn: (x) => x - Math.floor(x), doc: 'fractional part' },
  mod: { arity: [2, 2], fn: (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)), doc: 'floored modulo' },
  clamp: { arity: [3, 3], fn: (x, a, c) => Math.max(a, Math.min(c, x)), doc: 'clamp(x, lo, hi)' },
  mix: { arity: [3, 3], fn: (a, c, t) => a + (c - a) * t, doc: 'linear interpolation' },
  step: { arity: [2, 2], fn: (edge, x) => (x < edge ? 0 : 1), doc: 'step(edge, x)' },
  smoothstep: { arity: [3, 3], fn: (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0 || 1e-9))); return t * t * (3 - 2 * t); }, doc: 'Hermite smoothstep' },
  sign: { arity: [1, 1], fn: Math.sign, doc: 'sign' },
  noise: { arity: [1, 1], fn: noise1, doc: 'smooth value noise in [0,1]' },
  rand: { arity: [1, 1], fn: hash, doc: 'hash of x in [0,1)' },
  saw: { arity: [1, 1], fn: (x) => x - Math.floor(x), doc: 'sawtooth with period 1' },
  tri: { arity: [1, 1], fn: (x) => 1 - Math.abs(2 * (x - Math.floor(x)) - 1), doc: 'triangle wave with period 1' },
  square: { arity: [1, 1], fn: (x) => (x - Math.floor(x) < 0.5 ? 1 : -1), doc: 'square wave with period 1' },
  pulse: { arity: [3, 3], fn: (t, period, width) => ((t % period) + period) % period < width ? 1 : 0, doc: 'pulse(t, period, width)' },
};

export const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: Math.PI * 2, e: Math.E, phi: (1 + Math.sqrt(5)) / 2 };

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string } | { k: 'end' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
      if (!m) throw new ExpressionError(`bad number at ${i}`);
      out.push({ k: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/)!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||', '**'].includes(two)) {
      out.push({ k: 'op', v: two === '**' ? '^' : two });
      i += 2;
      continue;
    }
    if ('+-*/%^(),<>?:!'.includes(ch)) {
      out.push({ k: 'op', v: ch });
      i++;
      continue;
    }
    throw new ExpressionError(`unexpected character "${ch}" at ${i}`);
  }
  out.push({ k: 'end' });
  return out;
}

export class ExpressionError extends Error {}

/** Compile an expression. Throws ExpressionError with a readable message on syntax errors. */
export function compile(src: string): { fn: Compiled; variables: string[] } {
  if (typeof src !== 'string') throw new ExpressionError('expression must be a string');
  if (src.length > MAX_LENGTH) throw new ExpressionError(`expression longer than ${MAX_LENGTH} characters`);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const vars = new Set<string>();
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return t.k === 'op' && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExpressionError(`expected "${v}"`); p++; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new ExpressionError('expression nested too deeply'); };

  const ternary = (): Compiled => {
    enter();
    const cond = or();
    if (isOp('?')) {
      p++;
      const a = ternary();
      expect(':');
      const b2 = ternary();
      depth--;
      return (s) => (cond(s) ? a(s) : b2(s));
    }
    depth--;
    return cond;
  };
  const or = (): Compiled => {
    let l = and();
    while (isOp('||')) { p++; const a = l, r = and(); l = (s) => (a(s) || r(s) ? 1 : 0); }
    return l;
  };
  const and = (): Compiled => {
    let l = cmp();
    while (isOp('&&')) { p++; const a = l, r = cmp(); l = (s) => (a(s) && r(s) ? 1 : 0); }
    return l;
  };
  const cmp = (): Compiled => {
    let l = add();
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !['<', '>', '<=', '>=', '==', '!='].includes(t.v)) return l;
      p++;
      const a = l, r = add(), op = t.v;
      l = (s) => {
        const x = a(s), y = r(s);
        switch (op) {
          case '<': return x < y ? 1 : 0;
          case '>': return x > y ? 1 : 0;
          case '<=': return x <= y ? 1 : 0;
          case '>=': return x >= y ? 1 : 0;
          case '==': return Math.abs(x - y) < 1e-9 ? 1 : 0;
          default: return Math.abs(x - y) >= 1e-9 ? 1 : 0;
        }
      };
    }
  };
  const add = (): Compiled => {
    let l = mul();
    for (;;) {
      if (isOp('+')) { p++; const a = l, r = mul(); l = (s) => a(s) + r(s); }
      else if (isOp('-')) { p++; const a = l, r = mul(); l = (s) => a(s) - r(s); }
      else return l;
    }
  };
  const mul = (): Compiled => {
    let l = unary();
    for (;;) {
      if (isOp('*')) { p++; const a = l, r = unary(); l = (s) => a(s) * r(s); }
      else if (isOp('/')) { p++; const a = l, r = unary(); l = (s) => { const d = r(s); return d === 0 ? 0 : a(s) / d; }; }
      else if (isOp('%')) { p++; const a = l, r = unary(); l = (s) => { const d = r(s); return d === 0 ? 0 : a(s) % d; }; }
      else return l;
    }
  };
  const unary = (): Compiled => {
    if (isOp('-')) { p++; const a = unary(); return (s) => -a(s); }
    if (isOp('+')) { p++; return unary(); }
    if (isOp('!')) { p++; const a = unary(); return (s) => (a(s) ? 0 : 1); }
    return power();
  };
  const power = (): Compiled => {
    const base = atom();
    if (isOp('^')) { p++; const ex = unary(); return (s) => Math.pow(base(s), ex(s)); }
    return base;
  };
  const atom = (): Compiled => {
    enter();
    const t = peek();
    try {
      if (t.k === 'num') { p++; const v = t.v; return () => v; }
      if (t.k === 'op' && t.v === '(') { p++; const e2 = ternary(); expect(')'); return e2; }
      if (t.k === 'id') {
        p++;
        const name = t.v;
        if (isOp('(')) {
          const f = FUNCTIONS[name];
          if (!f || !Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) throw new ExpressionError(`unknown function "${name}"`);
          p++;
          const args: Compiled[] = [];
          if (!isOp(')')) {
            args.push(ternary());
            while (isOp(',')) { p++; args.push(ternary()); }
          }
          expect(')');
          if (args.length < f.arity[0] || args.length > f.arity[1]) throw new ExpressionError(`${name}() takes ${f.arity[0] === f.arity[1] ? f.arity[0] : `${f.arity[0]}–${f.arity[1]}`} argument(s)`);
          const fn = f.fn;
          if (args.length === 1) { const a0 = args[0]; return (s) => fn(a0(s)); }
          if (args.length === 2) { const a0 = args[0], a1 = args[1]; return (s) => fn(a0(s), a1(s)); }
          return (s) => fn(...args.map((a) => a(s)));
        }
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) { const v = CONSTANTS[name]; return () => v; }
        vars.add(name);
        return (s) => {
          const v = s(name);
          return typeof v === 'number' && Number.isFinite(v) ? v : 0;
        };
      }
      throw new ExpressionError(t.k === 'end' ? 'unexpected end of expression' : `unexpected "${t.k === 'op' ? t.v : ''}"`);
    } finally {
      depth--;
    }
  };

  const fn = ternary();
  if (peek().k !== 'end') throw new ExpressionError('unexpected trailing input');
  const guarded: Compiled = (s) => {
    const v = fn(s);
    return Number.isFinite(v) ? v : 0;
  };
  return { fn: guarded, variables: [...vars] };
}

/** Compile with caching; returns null (and the error) for invalid input instead of throwing. */
const cache = new Map<string, { fn: Compiled; variables: string[] } | ExpressionError>();
export function tryCompile(src: string): { fn: Compiled; variables: string[] } | { error: string } {
  let hit = cache.get(src);
  if (!hit) {
    try { hit = compile(src); } catch (e) { hit = e instanceof ExpressionError ? e : new ExpressionError(String(e)); }
    if (cache.size > 500) cache.clear();
    cache.set(src, hit);
  }
  return hit instanceof ExpressionError ? { error: hit.message } : hit;
}

export function evaluate(src: string, vars: Record<string, number> = {}): number {
  const c = compile(src);
  return c.fn((n) => (Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : undefined));
}

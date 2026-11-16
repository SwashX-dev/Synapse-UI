/** Small, fast, seedable PRNG (sfc32) plus helpers. Deterministic across platforms. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number) {
    // splitmix32 to spread the seed into 4 words
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next(); this.b = next(); this.c = next(); this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }
  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hiExclusive: number): number { return lo + Math.floor(this.next() * (hiExclusive - lo)); }
  /** Standard normal via Box–Muller. */
  gauss(): number {
    const u = Math.max(1e-12, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Uniform point on the unit sphere. */
  onSphere(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const z = this.range(-1, 1);
    const t = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(t); out[1] = z; out[2] = r * Math.sin(t);
    return out;
  }
}

/** Parse "0x3A7F", "1234" or any string (hashed) into a 31-bit seed. */
export function parseSeed(input: string | number): number {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.abs(Math.floor(input)) % 2147483647;
  const s = String(input).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) % 2147483647;
  if (/^\d+$/.test(s)) return Number(s) % 2147483647;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647;
}

import { describe, expect, it } from 'vitest';
import { compile, evaluate, tryCompile } from '../../src/shared/expression';

describe('expression language', () => {
  it('evaluates arithmetic, precedence, functions and variables', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluate('-2 ^ 2')).toBe(-4);
    expect(evaluate('clamp(cpu.load / 100, 0, 1)', { 'cpu.load': 250 })).toBe(1);
    expect(evaluate('t > 1 ? 10 : 20', { t: 2 })).toBe(10);
    expect(evaluate('sin(pi / 2) + max(1, 5, 3)')).toBeCloseTo(6);
    expect(evaluate('mod(-1, 3)')).toBe(2);
    expect(evaluate('1 / 0')).toBe(0);
    expect(evaluate('unknown.var + 1')).toBe(1);
    expect(compile('a * b + audio.bass').variables.sort()).toEqual(['a', 'audio.bass', 'b']);
  });

  it('cannot reach JavaScript internals', () => {
    for (const src of ['constructor', 'this', '__proto__', 'globalThis', 'process', 'window']) {
      expect(evaluate(src)).toBe(0);
    }
    for (const src of ['constructor(1)', 'toString(1)', 'eval(1)', 'Function(1)', 'a.b(1)', '"str"', 'x = 1', 'a[0]', '`x`', '() => 1']) {
      expect(() => compile(src), src).toThrow();
    }
  });

  it('limits size and nesting', () => {
    expect(() => compile('1+'.repeat(600) + '1')).toThrow(/longer/);
    expect(() => compile('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested/);
    expect('error' in tryCompile('sin(')).toBe(true);
  });
});

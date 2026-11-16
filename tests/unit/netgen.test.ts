import { describe, expect, it } from 'vitest';
import { generateNetwork, type Algorithm, type Layout } from '../../src/renderer/graphics/netgen';

describe('network generation', () => {
  const algos: Algorithm[] = ['knn', 'small-world', 'scale-free', 'modular', 'geometric', 'great-circle'];
  for (const algorithm of algos) {
    it(`${algorithm}: simple graph with sensible degree`, () => {
      const net = generateNetwork({ nodes: 2000, degree: 6, algorithm, layout: 'sphere', shell: 0.2, clustering: 0.5, seed: 7 });
      const E = net.edges.length / 2;
      const seen = new Set<string>();
      for (let e = 0; e < E; e++) {
        const a = net.edges[e * 2], b = net.edges[e * 2 + 1];
        expect(a).not.toBe(b);
        const k = `${Math.min(a, b)}-${Math.max(a, b)}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
        expect(net.lengths[e]).toBeGreaterThan(0);
        expect(net.order[e]).toBeGreaterThanOrEqual(0);
      }
      const mean = (2 * E) / net.n;
      expect(mean).toBeGreaterThan(2);
      expect(mean).toBeLessThan(20);
    });
  }
  it('is deterministic for a seed', () => {
    const a = generateNetwork({ nodes: 500, degree: 4, algorithm: 'small-world', layout: 'sphere', shell: 0, clustering: 0.3, seed: 99 });
    const b = generateNetwork({ nodes: 500, degree: 4, algorithm: 'small-world', layout: 'sphere', shell: 0, clustering: 0.3, seed: 99 });
    expect(Array.from(a.edges)).toEqual(Array.from(b.edges));
  });
  it('supports every layout', () => {
    for (const layout of ['sphere', 'galaxy', 'genesis', 'constellation', 'singularity', 'lattice'] as Layout[]) {
      const net = generateNetwork({ nodes: 600, degree: 4, algorithm: 'knn', layout, shell: 0, clustering: 0.5, seed: 3 });
      expect(net.positions.every(Number.isFinite), layout).toBe(true);
      expect(net.edges.length, layout).toBeGreaterThan(0);
    }
  });
  it('generates a scale-free degree distribution with hubs', () => {
    const net = generateNetwork({ nodes: 4000, degree: 4, algorithm: 'scale-free', layout: 'sphere', shell: 0, clustering: 0, seed: 1 });
    const degs = Array.from(net.degree).sort((x, y) => y - x);
    expect(degs[0]).toBeGreaterThan(5 * ((2 * net.edges.length) / 2 / net.n));
  });
});

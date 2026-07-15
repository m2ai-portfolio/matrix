import { describe, it, expect } from 'vitest';
import {
  cosine,
  knnPredict,
  majorityPUp,
  perDomainPUp,
  evaluateLOO,
  type Labeled,
} from '../src/interest/predictor.js';
import { rankCards, type TitledLabeled } from '../src/interest/rank.js';

const v = (...xs: number[]): Float32Array => new Float32Array(xs);

// A linearly-separable fixture: 'up' articles cluster on the x-axis, 'down' on the y-axis.
const labeled: Labeled[] = [
  { turn_id: 'u1', verdict: 'up', domain: 'a.com', vec: v(1, 0, 0) },
  { turn_id: 'u2', verdict: 'up', domain: 'a.com', vec: v(0.9, 0.1, 0) },
  { turn_id: 'd1', verdict: 'down', domain: 'b.com', vec: v(0, 1, 0) },
  { turn_id: 'd2', verdict: 'down', domain: 'b.com', vec: v(0.1, 0.9, 0) },
];

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosine(v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0, 0), v(0, 1, 0))).toBeCloseTo(0);
  });
  it('is scale-invariant', () => {
    expect(cosine(v(2, 0, 0), v(5, 0, 0))).toBeCloseTo(1);
  });
});

describe('knnPredict', () => {
  it('predicts up for a vector near the up cluster', () => {
    const p = knnPredict(v(0.95, 0.05, 0), labeled, 3);
    expect(p.verdict).toBe('up');
    expect(p.pUp).toBeGreaterThan(0.5);
    expect(p.confidence).toBeGreaterThan(0);
  });
  it('leakage guard: excludeId removes the target from its own neighbor set', () => {
    const p = knnPredict(v(1, 0, 0), labeled, 4, 'u1');
    expect(p.neighbors.map((n) => n.turn_id)).not.toContain('u1');
    expect(p.neighbors.length).toBe(3);
  });
  it('falls back to a coin flip (pUp=0.5) when no neighbors survive exclusion', () => {
    const single: Labeled[] = [labeled[0]];
    expect(knnPredict(v(1, 0, 0), single, 3, 'u1').pUp).toBe(0.5);
  });
});

describe('baselines', () => {
  it('majorityPUp is the up-rate and respects LOO exclusion', () => {
    expect(majorityPUp(labeled)).toBeCloseTo(0.5);
    expect(majorityPUp(labeled, 'd1')).toBeCloseTo(2 / 3);
  });
  it('perDomainPUp uses same-domain rate, falls back to global for unseen domains', () => {
    expect(perDomainPUp(labeled, 'a.com')).toBeCloseTo(1);
    expect(perDomainPUp(labeled, 'b.com')).toBeCloseTo(0);
    expect(perDomainPUp(labeled, 'unseen.com')).toBeCloseTo(0.5);
  });
});

describe('evaluateLOO', () => {
  it('scores a separable set at perfect accuracy and beats the majority baseline', () => {
    const r = evaluateLOO(labeled, 3);
    expect(r.n).toBe(4);
    expect(r.predictor.acc).toBe(1);
    expect(r.predictor.brier).toBeLessThan(r.majority.brier);
    expect(r.perItem).toHaveLength(4);
  });
});

describe('rankCards (Q-20260706-0005 rung-1 surfacing)', () => {
  const titledLabeled: TitledLabeled[] = labeled.map((l, i) => ({
    ...l,
    title: `${l.verdict}-exemplar-${i}`,
  }));
  // Deterministic fake embedder: maps a known card text to a fixed vector, no network.
  const fake = (byText: Record<string, number[]>) => async (text: string) => byText[text] ?? [];

  it('ranks an up-cluster card above a down-cluster card and attaches the nearest exemplar', async () => {
    const cards = [
      { id: 'c-up', title: 'up', text: 'near up cluster' },
      { id: 'c-down', title: 'down', text: 'near down cluster' },
    ];
    const embed = fake({
      'up\nnear up cluster': [0.95, 0.05, 0],
      'down\nnear down cluster': [0.05, 0.95, 0],
    });
    const out = await rankCards(cards, titledLabeled, embed, 3);
    expect(out['c-up'].verdict).toBe('up');
    expect(out['c-down'].verdict).toBe('down');
    expect(out['c-up'].pUp).toBeGreaterThan(out['c-down'].pUp);
    // nearest exemplar is a real graded article, carrying its verdict + title for explainability.
    expect(out['c-up'].nearest_exemplar?.verdict).toBe('up');
    expect(typeof out['c-up'].nearest_exemplar?.title).toBe('string');
  });

  it('SKIPS a card whose embedding comes back empty — never a bogus 0.5 pick', async () => {
    const cards = [
      { id: 'ok', title: 'up', text: 'has embedding' },
      { id: 'dead', title: 'x', text: 'embed fails' },
    ];
    const embed = fake({ 'up\nhas embedding': [1, 0, 0] }); // 'x\nembed fails' -> [] (failure)
    const out = await rankCards(cards, titledLabeled, embed, 3);
    expect(out).toHaveProperty('ok');
    expect(out).not.toHaveProperty('dead');
  });

  it('rounds outputs and returns an empty map for no cards', async () => {
    expect(await rankCards([], titledLabeled, async () => [1, 0, 0], 3)).toEqual({});
    const out = await rankCards(
      [{ id: 'a', title: 't', text: 'body' }],
      titledLabeled,
      async () => [1, 0, 0],
      3,
    );
    expect(Number.isFinite(out['a'].pUp)).toBe(true);
    expect(out['a'].confidence).toBeGreaterThanOrEqual(0);
    expect(out['a'].confidence).toBeLessThanOrEqual(1);
  });
});

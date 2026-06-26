// Tests for the fidelity-eval predictors + baselines + the LLM-judge seam (zero network).

import { describe, it, expect, vi } from 'vitest';
import type { Grade } from './dataset.js';
import {
  approvalRate,
  l2,
  kNearest,
  similarity,
  knnPredictor,
  majorityClassBaseline,
  perDomainBaseline,
  llmJudgePredictor,
  type Judge,
} from './predictors.js';

function grade(id: string, verdict: 'up' | 'down', vec: number[], domain = 'd', notes = ''): Grade {
  return {
    turnId: id,
    content: `article ${id}`,
    verdict,
    notes,
    domain,
    url: `u-${id}`,
    vector: new Float32Array(vec),
  };
}

describe('helpers', () => {
  it('approvalRate', () => {
    expect(approvalRate([])).toBe(0);
    expect(approvalRate([grade('a', 'up', [0]), grade('b', 'down', [0])])).toBe(0.5);
  });
  it('l2 + similarity ordering', () => {
    expect(l2(new Float32Array([0, 0]), new Float32Array([3, 4]))).toBe(5);
    expect(similarity(0)).toBe(1);
    expect(similarity(1)).toBeCloseTo(0.5);
  });
  it('kNearest returns the closest first and respects k', () => {
    const held = grade('h', 'up', [0, 0]);
    const ctx = [
      grade('far', 'down', [10, 10]),
      grade('near', 'up', [0, 1]),
      grade('mid', 'up', [3, 0]),
    ];
    const got = kNearest(held, ctx, 2);
    expect(got.map((n) => n.grade.turnId)).toEqual(['near', 'mid']);
  });
});

describe('knnPredictor', () => {
  it('votes with the nearest neighbors (similarity-weighted)', async () => {
    const held = grade('h', 'up', [0, 0]);
    const ctx = [
      grade('n1', 'up', [0, 0.1]),
      grade('n2', 'up', [0.1, 0]),
      grade('far', 'down', [50, 50]),
    ];
    const p = await knnPredictor(2)(held, ctx);
    expect(p.verdict).toBe('up');
    expect(p.pUp).toBeGreaterThan(0.9);
  });
  it('falls back to context approval rate with no neighbors (k=0)', async () => {
    const held = grade('h', 'up', [0]);
    const ctx = [grade('a', 'up', [0]), grade('b', 'down', [0]), grade('c', 'up', [0])];
    const p = await knnPredictor(0)(held, ctx);
    expect(p.pUp).toBeCloseTo(2 / 3);
  });
});

describe('baselines', () => {
  it('majority-class predicts the context majority', async () => {
    const ctx = [grade('a', 'up', [0]), grade('b', 'up', [0]), grade('c', 'down', [0])];
    const p = await majorityClassBaseline(grade('h', 'down', [0]), ctx);
    expect(p.verdict).toBe('up');
    expect(p.pUp).toBeCloseTo(2 / 3);
  });
  it('per-domain uses same-domain rate, falls back to global for a singleton domain', async () => {
    const ctx = [
      grade('a', 'down', [0], 'foo.com'),
      grade('b', 'down', [0], 'foo.com'),
      grade('c', 'up', [0], 'bar.com'),
    ];
    // held-out domain foo.com -> 0/2 up -> down
    expect((await perDomainBaseline(grade('h', 'up', [0], 'foo.com'), ctx)).verdict).toBe('down');
    // held-out domain new.com (singleton, no context) -> global rate 1/3 -> down
    const g = await perDomainBaseline(grade('h2', 'up', [0], 'new.com'), ctx);
    expect(g.pUp).toBeCloseTo(1 / 3);
  });
});

describe('llmJudgePredictor', () => {
  it('maps judge confidence to pUp and never leaks the held-out notes', async () => {
    const held = grade('h', 'down', [0, 0], 'd', 'SECRET held-out rationale that reveals down');
    const ctx = [grade('n1', 'up', [0, 0.1], 'd', 'context note ok')];
    const seen: string[] = [];
    const judge: Judge = vi.fn(async (input) => {
      seen.push(JSON.stringify(input));
      return { verdict: 'down' as const, confidence: 0.8 };
    });
    const p = await llmJudgePredictor(judge, 5)(held, ctx);
    expect(p.verdict).toBe('down');
    expect(p.pUp).toBeCloseTo(0.2); // down @ 0.8 conf -> pUp = 0.2
    // leakage guard: the held-out notes string must never appear in what the judge received.
    expect(seen.join('')).not.toContain('SECRET held-out rationale');
    // but the context note IS allowed.
    expect(seen.join('')).toContain('context note ok');
  });
  it('clamps a bad confidence so Brier cannot be poisoned', async () => {
    const judge: Judge = async () => ({ verdict: 'up', confidence: 99 });
    const p = await llmJudgePredictor(judge, 1)(grade('h', 'up', [0]), [grade('a', 'up', [0])]);
    expect(p.pUp).toBe(1);
  });
});

// Tests for the leave-one-out harness, including the leakage guard (held-out item never in context).

import { describe, it, expect } from 'vitest';
import type { Grade } from './dataset.js';
import { leaveOneOutFolds, runFidelityEval } from './harness.js';
import { knnPredictor, majorityClassBaseline, type Predictor } from './predictors.js';

function grade(id: string, verdict: 'up' | 'down', vec: number[]): Grade {
  return {
    turnId: id,
    content: id,
    verdict,
    notes: '',
    domain: 'd',
    url: id,
    vector: new Float32Array(vec),
  };
}

const set: Grade[] = [
  grade('a', 'up', [0, 0]),
  grade('b', 'up', [0, 1]),
  grade('c', 'down', [9, 9]),
];

describe('leaveOneOutFolds', () => {
  it('produces N folds, each excluding exactly the held-out item', () => {
    const folds = leaveOneOutFolds(set);
    expect(folds).toHaveLength(3);
    for (const f of folds) {
      expect(f.context).toHaveLength(2);
      expect(f.context.map((g) => g.turnId)).not.toContain(f.heldOut.turnId);
    }
  });
});

describe('runFidelityEval', () => {
  it('scores every predictor over the same folds', async () => {
    const report = await runFidelityEval(set, [
      { name: 'majority', predictor: majorityClassBaseline },
      { name: 'knn@1', predictor: knnPredictor(1) },
    ]);
    expect(report.n).toBe(3);
    expect(report.upCount).toBe(2);
    expect(report.downCount).toBe(1);
    expect(report.predictors.map((p) => p.name)).toEqual(['majority', 'knn@1']);
    for (const p of report.predictors) expect(p.metrics.n).toBe(3);
  });

  it('passes each predictor a context that never contains the held-out verdict', async () => {
    const observed: Array<{ held: string; ctx: string[] }> = [];
    const spy: Predictor = (held, ctx) => {
      observed.push({ held: held.turnId, ctx: ctx.map((g) => g.turnId) });
      return { verdict: 'up', pUp: 1 };
    };
    await runFidelityEval(set, [{ name: 'spy', predictor: spy }]);
    expect(observed).toHaveLength(3);
    for (const o of observed) expect(o.ctx).not.toContain(o.held);
  });
});

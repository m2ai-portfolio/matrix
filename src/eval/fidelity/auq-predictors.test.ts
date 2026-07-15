// Tests for the AUQ forced-choice predictors + LOO harness. Zero-network: the judge is a
// deterministic fake injected via the ChoiceJudge seam.

import { describe, it, expect } from 'vitest';
import type { AuqTriple } from './auq-dataset.js';
import {
  alwaysRecommendedPredictor,
  kNearestTriples,
  judgePredictor,
  clampIdx,
  type ChoiceJudge,
} from './auq-predictors.js';
import {
  runAuqEval,
  scoreChoice,
  expectedRandomAccuracy,
  alwaysRecommendedAccuracy,
  baselineIdxOf,
  runChoicePredictorLOO,
} from './auq-harness.js';

function triple(
  id: string,
  options: string[],
  chosenIdx: number,
  recommendedIdx: number | null,
  vector?: number[],
): AuqTriple {
  return {
    id,
    situation: `situation ${id}`,
    header: '',
    options,
    chosen: options[chosenIdx],
    chosenIdx,
    rejected: options.filter((_, i) => i !== chosenIdx),
    recommendedIdx,
    multiSelect: false,
    vector: vector ? new Float32Array(vector) : undefined,
  };
}

describe('alwaysRecommendedPredictor + baseline', () => {
  it('picks the recommended index when present, else index 0', () => {
    expect(alwaysRecommendedPredictor(triple('a', ['x', 'y'], 1, 0), [])).toBe(0);
    expect(alwaysRecommendedPredictor(triple('b', ['x', 'y', 'z'], 0, 2), [])).toBe(2);
    expect(alwaysRecommendedPredictor(triple('c', ['x', 'y'], 1, null), [])).toBe(0);
  });

  it('baselineIdxOf matches the predictor', () => {
    expect(baselineIdxOf(triple('a', ['x', 'y'], 1, null))).toBe(0);
    expect(baselineIdxOf(triple('b', ['x', 'y', 'z'], 0, 2))).toBe(2);
  });
});

describe('clampIdx', () => {
  it('keeps a valid index and replaces an out-of-range one with 0', () => {
    expect(clampIdx(2, 4)).toBe(2);
    expect(clampIdx(-1, 4)).toBe(0);
    expect(clampIdx(9, 4)).toBe(0);
    expect(clampIdx(1.5, 4)).toBe(0);
  });
});

describe('kNearestTriples', () => {
  it('returns the k closest context triples by L2 over situation vectors', () => {
    const held = triple('h', ['a', 'b'], 0, null, [0, 0]);
    const ctx = [
      triple('far', ['a', 'b'], 0, null, [9, 9]),
      triple('near', ['a', 'b'], 0, null, [0, 1]),
      triple('mid', ['a', 'b'], 0, null, [3, 0]),
    ];
    const knn = kNearestTriples(held, ctx, 2);
    expect(knn.map((n) => n.triple.id)).toEqual(['near', 'mid']);
  });

  it('returns nothing when the held-out item has no vector', () => {
    const held = triple('h', ['a', 'b'], 0, null);
    const ctx = [triple('c', ['a', 'b'], 0, null, [1, 1])];
    expect(kNearestTriples(held, ctx, 3)).toHaveLength(0);
  });
});

describe('judgePredictor', () => {
  it('zero-shot (k=0) passes no examples and returns the clamped judge index', async () => {
    let sawExamples = -1;
    const fake: ChoiceJudge = async (input) => {
      sawExamples = input.examples.length;
      return { chosenIdx: 1 };
    };
    const held = triple('h', ['a', 'b', 'c'], 2, 0, [0, 0]);
    const ctx = [triple('c1', ['a', 'b'], 0, null, [0, 1])];
    const idx = await judgePredictor(fake, 0)(held, ctx);
    expect(sawExamples).toBe(0);
    expect(idx).toBe(1);
  });

  it('kNN few-shot (k>0) supplies retrieved prior picks as examples', async () => {
    let sawExamples = -1;
    const fake: ChoiceJudge = async (input) => {
      sawExamples = input.examples.length;
      return { chosenIdx: 0 };
    };
    const held = triple('h', ['a', 'b'], 0, null, [0, 0]);
    const ctx = [
      triple('c1', ['a', 'b'], 1, null, [0, 1]),
      triple('c2', ['a', 'b'], 0, null, [5, 5]),
    ];
    await judgePredictor(fake, 2)(held, ctx);
    expect(sawExamples).toBe(2);
  });
});

describe('scoring', () => {
  const triples = [
    triple('t1', ['a', 'b'], 0, 0, [0, 0]), // follows baseline (rec=0, chose 0)
    triple('t2', ['a', 'b'], 1, 0, [1, 0]), // deviation (rec=0, chose 1)
    triple('t3', ['a', 'b', 'c'], 2, 0, [0, 1]), // deviation (rec=0, chose 2)
  ];

  it('expectedRandomAccuracy is the mean of 1/n', () => {
    // (1/2 + 1/2 + 1/3) / 3 = (0.5 + 0.5 + 0.3333) / 3
    expect(expectedRandomAccuracy(triples)).toBeCloseTo((0.5 + 0.5 + 1 / 3) / 3, 6);
  });

  it('alwaysRecommendedAccuracy counts baseline hits', () => {
    const acc = alwaysRecommendedAccuracy(triples);
    expect(acc.correct).toBe(1); // only t1 follows the baseline
    expect(acc.n).toBe(3);
  });

  it('scoreChoice splits accuracy into deviation vs follow', async () => {
    // a predictor that always returns the actual chosen index -> perfect
    const folds = await runChoicePredictorLOO(triples, (held) => held.chosenIdx);
    const m = scoreChoice(folds);
    expect(m.accuracy).toBe(1);
    expect(m.deviationN).toBe(2);
    expect(m.deviationCorrect).toBe(2);
    expect(m.followN).toBe(1);
  });

  it('a baseline-mimicking predictor gets the follow cases and misses the deviations', async () => {
    const folds = await runChoicePredictorLOO(triples, (held) => baselineIdxOf(held));
    const m = scoreChoice(folds);
    expect(m.followCorrect).toBe(1);
    expect(m.followN).toBe(1);
    expect(m.deviationCorrect).toBe(0);
    expect(m.deviationN).toBe(2);
  });

  it('bounded concurrency preserves result order and values (vs sequential)', async () => {
    // a predictor whose latency varies by index, so out-of-order completion is exercised
    const predictor = async (held: AuqTriple) => {
      await new Promise((r) => setTimeout(r, (held.id.charCodeAt(held.id.length - 1) % 5) * 2));
      return held.chosenIdx;
    };
    const seq = await runChoicePredictorLOO(triples, predictor, { concurrency: 1 });
    const par = await runChoicePredictorLOO(triples, predictor, { concurrency: 4 });
    expect(par.map((f) => f.id)).toEqual(seq.map((f) => f.id));
    expect(par.map((f) => f.predictedIdx)).toEqual(seq.map((f) => f.predictedIdx));
  });
});

describe('runAuqEval', () => {
  it('runs predictors over LOO and reports both baselines + distribution', async () => {
    const triples = [
      triple('t1', ['a', 'b'], 0, 0, [0, 0]),
      triple('t2', ['a', 'b'], 1, 0, [1, 0]),
      triple('t3', ['a', 'b', 'c'], 2, 0, [0, 1]),
    ];
    const report = await runAuqEval(triples, [
      { name: 'baseline:always-recommended', predictor: alwaysRecommendedPredictor },
    ]);
    expect(report.n).toBe(3);
    expect(report.optionCountDistribution).toEqual({ 2: 2, 3: 1 });
    expect(report.baselineAlwaysRecommended.correct).toBe(1);
    expect(report.predictors[0].metrics.accuracy).toBeCloseTo(1 / 3, 6);
  });
});

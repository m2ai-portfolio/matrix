// Matrix v1 decision-fidelity eval: metrics.
// See ./CONTRACT.md. Accuracy is the primary decision-fidelity number; Brier is the calibration
// number. Both are reported per predictor alongside the baselines; nothing is blended.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Verdict } from './dataset.js';

/** One scored fold: what the predictor said vs the truth, for one held-out item. */
export interface FoldResult {
  turnId: string;
  domain: string;
  actual: Verdict;
  predicted: Verdict;
  pUp: number;
}

export interface Metrics {
  n: number;
  correct: number;
  /** correct / n. */
  accuracy: number;
  /** mean( (pUp - 1[actual=up])^2 ); lower is better. */
  brier: number;
  /** Confusion counts for the positive class 'up'. */
  truePos: number;
  falsePos: number;
  trueNeg: number;
  falseNeg: number;
}

/** Score a set of folds into accuracy + Brier + confusion. */
export function score(folds: FoldResult[]): Metrics {
  let correct = 0;
  let brierSum = 0;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const f of folds) {
    const actualUp = f.actual === 'up' ? 1 : 0;
    if (f.predicted === f.actual) correct++;
    brierSum += (f.pUp - actualUp) ** 2;
    if (f.actual === 'up' && f.predicted === 'up') tp++;
    else if (f.actual === 'down' && f.predicted === 'up') fp++;
    else if (f.actual === 'down' && f.predicted === 'down') tn++;
    else fn++;
  }
  const n = folds.length;
  return {
    n,
    correct,
    accuracy: n > 0 ? correct / n : 0,
    brier: n > 0 ? brierSum / n : 0,
    truePos: tp,
    falsePos: fp,
    trueNeg: tn,
    falseNeg: fn,
  };
}

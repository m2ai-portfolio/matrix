// Tests for the fidelity-eval metrics (accuracy + Brier + confusion).

import { describe, it, expect } from 'vitest';
import { score, type FoldResult } from './metrics.js';

function fold(actual: 'up' | 'down', predicted: 'up' | 'down', pUp: number): FoldResult {
  return { turnId: 't', domain: 'd', actual, predicted, pUp };
}

describe('score', () => {
  it('computes accuracy, Brier, and confusion', () => {
    const folds = [
      fold('up', 'up', 1), // correct, brier 0, TP
      fold('down', 'down', 0), // correct, brier 0, TN
      fold('up', 'down', 0), // wrong, brier 1, FN
      fold('down', 'up', 1), // wrong, brier 1, FP
    ];
    const m = score(folds);
    expect(m.n).toBe(4);
    expect(m.correct).toBe(2);
    expect(m.accuracy).toBe(0.5);
    expect(m.brier).toBe(0.5); // (0+0+1+1)/4
    expect(m).toMatchObject({ truePos: 1, trueNeg: 1, falseNeg: 1, falsePos: 1 });
  });
  it('handles an empty set without dividing by zero', () => {
    const m = score([]);
    expect(m.accuracy).toBe(0);
    expect(m.brier).toBe(0);
  });
  it('rewards calibrated probabilities via Brier', () => {
    const confident = score([fold('up', 'up', 0.99)]);
    const hedged = score([fold('up', 'up', 0.6)]);
    expect(confident.brier).toBeLessThan(hedged.brier);
  });
});

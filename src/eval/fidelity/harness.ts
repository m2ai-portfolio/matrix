// Matrix v1 decision-fidelity eval: leave-one-out harness.
// See ./CONTRACT.md. Reusable, parameterized by the grade set + named predictors. Runs every
// predictor over the same LOO folds so accuracy/Brier are directly comparable, predictor vs baseline.
//
// LEAKAGE GUARD: each fold's context is strictly the other grades (held-out item removed by turnId),
// so no held-out verdict or note can reach a predictor.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Grade } from './dataset.js';
import type { Predictor } from './predictors.js';
import { score, type FoldResult, type Metrics } from './metrics.js';

export interface NamedPredictor {
  name: string;
  predictor: Predictor;
}

export interface PredictorReport {
  name: string;
  metrics: Metrics;
  folds: FoldResult[];
}

export interface EvalReport {
  n: number;
  upCount: number;
  downCount: number;
  predictors: PredictorReport[];
}

/** Build the leave-one-out folds: for each grade, (heldOut, contextOfTheRest). */
export function leaveOneOutFolds(grades: Grade[]): Array<{ heldOut: Grade; context: Grade[] }> {
  return grades.map((heldOut) => ({
    heldOut,
    context: grades.filter((g) => g.turnId !== heldOut.turnId),
  }));
}

/** Run one predictor across all LOO folds. */
export async function runPredictorLOO(
  grades: Grade[],
  predictor: Predictor,
): Promise<FoldResult[]> {
  const folds = leaveOneOutFolds(grades);
  const results: FoldResult[] = [];
  for (const { heldOut, context } of folds) {
    const p = await predictor(heldOut, context);
    results.push({
      turnId: heldOut.turnId,
      domain: heldOut.domain,
      actual: heldOut.verdict,
      predicted: p.verdict,
      pUp: p.pUp,
    });
  }
  return results;
}

/** Run every named predictor over the same grade set and score each. */
export async function runFidelityEval(
  grades: Grade[],
  predictors: NamedPredictor[],
): Promise<EvalReport> {
  let up = 0;
  for (const g of grades) if (g.verdict === 'up') up++;

  const reports: PredictorReport[] = [];
  for (const { name, predictor } of predictors) {
    const folds = await runPredictorLOO(grades, predictor);
    reports.push({ name, metrics: score(folds), folds });
  }
  return {
    n: grades.length,
    upCount: up,
    downCount: grades.length - up,
    predictors: reports,
  };
}

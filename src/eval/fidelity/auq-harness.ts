// Matrix forced-choice fidelity eval (AUQ lane): leave-one-out harness + metrics.
// See ./AUQ-CONTRACT.md. Reusable, parameterized by the triple set + named predictors. Runs every
// predictor over the same LOO folds so top-1 accuracy is directly comparable, predictor vs baseline.
//
// LEAKAGE GUARD: each fold's context is strictly the other triples (held-out removed by id), so no
// held-out chosen index can reach a predictor; the situation never contains an option label.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { AuqTriple } from './auq-dataset.js';
import type { ChoicePredictor } from './auq-predictors.js';

/** The always-recommended/first baseline pick for a triple (recommended option, else index 0). */
export function baselineIdxOf(t: AuqTriple): number {
  return t.recommendedIdx ?? 0;
}

/** One scored fold: what the predictor said vs the truth, for one held-out triple. */
export interface ChoiceFoldResult {
  id: string;
  nOptions: number;
  actualIdx: number;
  predictedIdx: number;
  baselineIdx: number;
  /** True when the owner did NOT pick the baseline option (the high-value deviation cases). */
  deviation: boolean;
}

export interface ChoiceMetrics {
  n: number;
  correct: number;
  accuracy: number;
  /** Cases where the owner deviated from the baseline pick (baseline is wrong on these by definition). */
  deviationN: number;
  deviationCorrect: number;
  deviationAccuracy: number;
  /** Cases where the owner took the baseline pick. */
  followN: number;
  followCorrect: number;
  followAccuracy: number;
}

/** Build the leave-one-out folds: for each triple, (heldOut, contextOfTheRest). */
export function leaveOneOutFoldsAuq(
  triples: AuqTriple[],
): Array<{ heldOut: AuqTriple; context: AuqTriple[] }> {
  return triples.map((heldOut) => ({
    heldOut,
    context: triples.filter((t) => t.id !== heldOut.id),
  }));
}

export interface LOOOptions {
  /** Max folds in flight at once. Default 1 (sequential, deterministic for tests). */
  concurrency?: number;
  /** Progress callback, invoked as folds complete (count, total). */
  log?: (done: number, total: number) => void;
}

/**
 * Run one forced-choice predictor across all LOO folds. Folds are independent, so they may run with
 * bounded concurrency (a network judge over hundreds of folds is otherwise minutes of latency); the
 * result order is preserved by index regardless of completion order, so scoring is unaffected.
 */
export async function runChoicePredictorLOO(
  triples: AuqTriple[],
  predictor: ChoicePredictor,
  opts: LOOOptions = {},
): Promise<ChoiceFoldResult[]> {
  const folds = leaveOneOutFoldsAuq(triples);
  const results: ChoiceFoldResult[] = new Array<ChoiceFoldResult>(folds.length);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= folds.length) return;
      const { heldOut, context } = folds[i];
      const predictedIdx = await predictor(heldOut, context);
      const baselineIdx = baselineIdxOf(heldOut);
      results[i] = {
        id: heldOut.id,
        nOptions: heldOut.options.length,
        actualIdx: heldOut.chosenIdx,
        predictedIdx,
        baselineIdx,
        deviation: heldOut.chosenIdx !== baselineIdx,
      };
      done++;
      if (opts.log && done % 50 === 0) opts.log(done, folds.length);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, folds.length) }, () => worker());
  await Promise.all(pool);
  if (opts.log) opts.log(done, folds.length);
  return results;
}

/** Score forced-choice folds into top-1 accuracy + deviation/follow breakdown. */
export function scoreChoice(folds: ChoiceFoldResult[]): ChoiceMetrics {
  let correct = 0;
  let devN = 0;
  let devCorrect = 0;
  let folN = 0;
  let folCorrect = 0;
  for (const f of folds) {
    const hit = f.predictedIdx === f.actualIdx;
    if (hit) correct++;
    if (f.deviation) {
      devN++;
      if (hit) devCorrect++;
    } else {
      folN++;
      if (hit) folCorrect++;
    }
  }
  const n = folds.length;
  return {
    n,
    correct,
    accuracy: n > 0 ? correct / n : 0,
    deviationN: devN,
    deviationCorrect: devCorrect,
    deviationAccuracy: devN > 0 ? devCorrect / devN : 0,
    followN: folN,
    followCorrect: folCorrect,
    followAccuracy: folN > 0 ? folCorrect / folN : 0,
  };
}

/** Expected accuracy of the 1/N random baseline = mean over triples of 1/(option count). Analytic. */
export function expectedRandomAccuracy(triples: AuqTriple[]): number {
  if (triples.length === 0) return 0;
  let sum = 0;
  for (const t of triples) sum += 1 / t.options.length;
  return sum / triples.length;
}

/** Accuracy of the always-recommended/first baseline (no network, computed directly from the truth). */
export function alwaysRecommendedAccuracy(triples: AuqTriple[]): {
  correct: number;
  n: number;
  accuracy: number;
} {
  let correct = 0;
  for (const t of triples) if (t.chosenIdx === baselineIdxOf(t)) correct++;
  const n = triples.length;
  return { correct, n, accuracy: n > 0 ? correct / n : 0 };
}

/** Option-count distribution among the triples (e.g. {2: 91, 3: 273, 4: 64}). */
export function optionCountDistribution(triples: AuqTriple[]): Record<number, number> {
  const dist: Record<number, number> = {};
  for (const t of triples) dist[t.options.length] = (dist[t.options.length] ?? 0) + 1;
  return dist;
}

export interface NamedChoicePredictor {
  name: string;
  predictor: ChoicePredictor;
}

export interface ChoicePredictorReport {
  name: string;
  metrics: ChoiceMetrics;
  folds: ChoiceFoldResult[];
}

export interface AuqEvalReport {
  n: number;
  optionCountDistribution: Record<number, number>;
  baselineAlwaysRecommended: { correct: number; n: number; accuracy: number };
  baselineRandomExpected: number;
  predictors: ChoicePredictorReport[];
}

/** Run every named predictor over the same triple set and score each, alongside the two baselines. */
export async function runAuqEval(
  triples: AuqTriple[],
  predictors: NamedChoicePredictor[],
  opts: { concurrency?: number; log?: (line: string) => void } = {},
): Promise<AuqEvalReport> {
  const reports: ChoicePredictorReport[] = [];
  for (const { name, predictor } of predictors) {
    const folds = await runChoicePredictorLOO(triples, predictor, {
      concurrency: opts.concurrency,
      log: opts.log
        ? (done, total) => opts.log!(`[auq-fidelity] ${name}: ${done}/${total}`)
        : undefined,
    });
    reports.push({ name, metrics: scoreChoice(folds), folds });
  }
  return {
    n: triples.length,
    optionCountDistribution: optionCountDistribution(triples),
    baselineAlwaysRecommended: alwaysRecommendedAccuracy(triples),
    baselineRandomExpected: expectedRandomAccuracy(triples),
    predictors: reports,
  };
}

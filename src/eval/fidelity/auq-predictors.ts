// Matrix forced-choice fidelity eval (AUQ lane): predictors + baselines.
// See ./AUQ-CONTRACT.md. A predictor maps (held-out triple, context of prior triples) to a chosen
// option INDEX. Predictors are leakage-safe: they receive only the context triples (never the
// held-out chosen index), and the situation never contains an option label (guarded in the dataset).
//
// kNN design note (decided per the goal card Assumptions): a standalone local kNN cannot pick a
// concrete option, because a neighbour's picked LABEL does not exist in the held-out item's option
// set and a "deviation" has no concrete target. So the situation embedding is used for the JUDGE's
// few-shot retrieval (kNN-retrieved prior picks), and the kNN contribution is measured as judge
// zero-shot vs judge kNN-few-shot. The two non-network baselines remain: always-recommended/first
// and 1/N random (the latter reported analytically; see auq-harness).
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { AuqTriple } from './auq-dataset.js';
import { l2 } from './predictors.js';

/** A forced-choice predictor returns the index (into heldOut.options) it predicts the owner picked. */
export type ChoicePredictor = (
  heldOut: AuqTriple,
  context: AuqTriple[],
) => number | Promise<number>;

/** Baseline: pick the explicit "(recommended)" option if present, else the first option (index 0). */
export const alwaysRecommendedPredictor: ChoicePredictor = (heldOut) => heldOut.recommendedIdx ?? 0;

export interface AuqNeighbor {
  triple: AuqTriple;
  distance: number;
}

/** The k context triples nearest the held-out situation vector, ascending by L2 distance. */
export function kNearestTriples(
  heldOut: AuqTriple,
  context: AuqTriple[],
  k: number,
): AuqNeighbor[] {
  if (!heldOut.vector) return [];
  const hv = heldOut.vector;
  return context
    .filter((t) => t.vector && t.vector.length === hv.length)
    .map((t) => ({ triple: t, distance: l2(hv, t.vector as Float32Array) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, k));
}

// --- forced-choice LLM-judge seam (gated, network) -----------------------------------

/** One few-shot example shown to the judge: a prior situation, its options, and the owner's pick. */
export interface ChoiceExample {
  situation: string;
  options: string[];
  chosenIdx: number;
}

export interface ChoiceJudgeInput {
  /** The held-out situation. NO chosen index (leakage guard). */
  situation: string;
  /** The offered option labels to choose among. */
  options: string[];
  /** Nearest prior picks as the owner's labeled behaviour (empty for the zero-shot condition). */
  examples: ChoiceExample[];
}

export interface ChoiceJudgeOutput {
  /** The index (into `options`) the judge predicts the owner picked. */
  chosenIdx: number;
}

/** Injectable forced-choice judge. The real impl calls Gemini; tests inject a deterministic fake. */
export type ChoiceJudge = (input: ChoiceJudgeInput) => Promise<ChoiceJudgeOutput>;

/** Clamp a judge-returned index into the valid option range (a bad reply cannot crash the eval). */
export function clampIdx(idx: number, n: number): number {
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) return 0;
  return idx;
}

/**
 * Gemini forced-choice predictor. With `k > 0` it retrieves the k nearest prior situations (by the
 * situation embedding) as few-shot examples of the owner's picks; with `k = 0` it runs zero-shot.
 * The difference between the two conditions IS the measured kNN-retrieval contribution.
 */
export function judgePredictor(judge: ChoiceJudge, k: number): ChoicePredictor {
  return async (heldOut, context) => {
    const examples: ChoiceExample[] =
      k > 0
        ? kNearestTriples(heldOut, context, k).map((n) => ({
            situation: n.triple.situation,
            options: n.triple.options,
            chosenIdx: n.triple.chosenIdx,
          }))
        : [];
    const out = await judge({ situation: heldOut.situation, options: heldOut.options, examples });
    return clampIdx(out.chosenIdx, heldOut.options.length);
  };
}

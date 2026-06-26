// Matrix v1 decision-fidelity eval: predictors + baselines.
// See ./CONTRACT.md. A predictor maps (held-out article, context of prior grades) to a verdict
// plus a probability pUp used for calibration. All predictors are leakage-safe: they receive ONLY
// the context grades (never the held-out verdict), and never read the held-out item's notes.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Grade, Verdict } from './dataset.js';

export interface Prediction {
  verdict: Verdict;
  /** Predicted probability that the verdict is 'up', in [0,1]. Drives the Brier calibration score. */
  pUp: number;
}

/** Sync or async; the harness awaits either. */
export type Predictor = (heldOut: Grade, context: Grade[]) => Prediction | Promise<Prediction>;

/** Fraction of grades whose verdict is 'up'. 0 for an empty set. */
export function approvalRate(grades: Grade[]): number {
  if (grades.length === 0) return 0;
  let up = 0;
  for (const g of grades) if (g.verdict === 'up') up++;
  return up / grades.length;
}

/** L2 (Euclidean) distance between two equal-length vectors. */
export function l2(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector dim mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Convert a distance to a similarity weight (matches src/search/semantic.ts: larger = closer). */
export function similarity(distance: number): number {
  return 1 / (1 + distance);
}

export interface Neighbor {
  grade: Grade;
  distance: number;
}

/** The k context grades nearest the held-out vector, ascending by distance. */
export function kNearest(heldOut: Grade, context: Grade[], k: number): Neighbor[] {
  return context
    .map((g) => ({ grade: g, distance: l2(heldOut.vector, g.vector) }))
    .sort((x, y) => x.distance - y.distance)
    .slice(0, Math.max(0, k));
}

/** pUp >= 0.5 predicts 'up' (ties break to the global majority direction, 'up'). */
function verdictFromPUp(pUp: number): Verdict {
  return pUp >= 0.5 ? 'up' : 'down';
}

/**
 * embedding-kNN predictor: similarity-weighted vote of the k nearest prior grades' verdicts.
 * Local and deterministic. Falls back to the context approval rate when no neighbors exist.
 */
export function knnPredictor(k: number): Predictor {
  return (heldOut, context) => {
    const neighbors = kNearest(heldOut, context, k);
    if (neighbors.length === 0) {
      const pUp = approvalRate(context);
      return { verdict: verdictFromPUp(pUp), pUp };
    }
    let weightUp = 0;
    let weightAll = 0;
    for (const n of neighbors) {
      const w = similarity(n.distance);
      weightAll += w;
      if (n.grade.verdict === 'up') weightUp += w;
    }
    const pUp = weightAll > 0 ? weightUp / weightAll : approvalRate(context);
    return { verdict: verdictFromPUp(pUp), pUp };
  };
}

/** majority-class baseline: predict the context majority; pUp = context approval rate. */
export const majorityClassBaseline: Predictor = (_heldOut, context) => {
  const pUp = approvalRate(context);
  return { verdict: verdictFromPUp(pUp), pUp };
};

/**
 * per-domain approval-rate baseline: predict by the held-out item's domain approval rate among
 * context; if the domain is a singleton (no same-domain context this fold), fall back to the
 * global context approval rate.
 */
export const perDomainBaseline: Predictor = (heldOut, context) => {
  const sameDomain = context.filter((g) => g.domain === heldOut.domain);
  const pUp = sameDomain.length > 0 ? approvalRate(sameDomain) : approvalRate(context);
  return { verdict: verdictFromPUp(pUp), pUp };
};

// --- LLM-judge seam (gated, network) -------------------------------------------------

/** One labeled example shown to the judge (a context grade). Includes notes; the held-out item's do NOT. */
export interface JudgeExample {
  content: string;
  verdict: Verdict;
  notes: string;
  domain: string;
}

export interface JudgeInput {
  /** The held-out article body. NO verdict, NO notes (leakage guard). */
  article: string;
  domain: string;
  /** Nearest prior grades, as the owner's labeled behavior. */
  examples: JudgeExample[];
}

export interface JudgeOutput {
  verdict: Verdict;
  /** The judge's confidence in its own verdict, in [0,1]. */
  confidence: number;
}

/** Injectable judge. The real impl calls Gemini; tests inject a deterministic fake. */
export type Judge = (input: JudgeInput) => Promise<JudgeOutput>;

/** Clamp to [0,1]; coerce non-finite to 0.5 (max-uncertainty) so a bad judge reply cannot poison Brier. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}

/**
 * Gemini LLM-judge predictor: show the k nearest prior grades as labeled examples, ask the judge
 * to predict the held-out article's verdict + confidence. pUp = confidence if up else 1-confidence.
 */
export function llmJudgePredictor(judge: Judge, k: number): Predictor {
  return async (heldOut, context) => {
    const examples: JudgeExample[] = kNearest(heldOut, context, k).map((n) => ({
      content: n.grade.content,
      verdict: n.grade.verdict,
      notes: n.grade.notes,
      domain: n.grade.domain,
    }));
    const out = await judge({ article: heldOut.content, domain: heldOut.domain, examples });
    const conf = clamp01(out.confidence);
    const pUp = out.verdict === 'up' ? conf : 1 - conf;
    return { verdict: out.verdict, pUp };
  };
}

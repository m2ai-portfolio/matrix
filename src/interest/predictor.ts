// Soundwave Phase 3 — interest predictor (kNN over embedded grades).
// Card Q-20260706-0004. Pure logic only: vectors in, predictions out. No DB, no network,
// so tests are deterministic. The DB/network loaders live in data.ts; the CLI in run.ts.
//
// The predictor predicts P(up) for an article from its nearest ALREADY-GRADED Soundwave
// articles: retrieve top-k by cosine similarity, take a similarity-weighted vote of their
// verdicts. Everything is compared against two baselines (majority-class, per-domain prior)
// so a predictor that does not beat "just guess the prior" is visibly not worth trusting.

export type Verdict = 'up' | 'down';

/** One labeled point: an article the owner graded, with its embedding. */
export interface Labeled {
  turn_id: string;
  verdict: Verdict;
  domain: string;
  vec: Float32Array;
}

/** Cosine similarity. Vectors are stored L2-normalized, but we normalize defensively. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface Neighbor {
  turn_id: string;
  sim: number;
  verdict: Verdict;
}

export interface Prediction {
  /** Predicted probability the verdict is 'up', in [0,1]. */
  pUp: number;
  verdict: Verdict;
  /** Distance of pUp from the 0.5 coin-flip, scaled to [0,1]. */
  confidence: number;
  neighbors: Neighbor[];
}

/**
 * kNN predict P(up) for a target vector against the labeled set. `excludeId` removes the target
 * from its own neighbor set — the leakage guard that makes leave-one-out honest. Weight is the
 * (non-negative) cosine similarity, so closer graded articles count more.
 */
export function knnPredict(
  targetVec: Float32Array,
  labeled: Labeled[],
  k: number,
  excludeId?: string,
): Prediction {
  const neighbors = labeled
    .filter((l) => l.turn_id !== excludeId)
    .map((l) => ({ turn_id: l.turn_id, sim: cosine(targetVec, l.vec), verdict: l.verdict }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);

  let wSum = 0;
  let wUp = 0;
  for (const n of neighbors) {
    const w = Math.max(0, n.sim);
    wSum += w;
    if (n.verdict === 'up') wUp += w;
  }
  const pUp = wSum === 0 ? 0.5 : wUp / wSum;
  return {
    pUp,
    verdict: pUp >= 0.5 ? 'up' : 'down',
    confidence: Math.abs(pUp - 0.5) * 2,
    neighbors,
  };
}

/** Baseline #1: global up-rate (majority-class prior), LOO-excluding the target. */
export function majorityPUp(labeled: Labeled[], excludeId?: string): number {
  const set = labeled.filter((l) => l.turn_id !== excludeId);
  if (set.length === 0) return 0.5;
  return set.filter((l) => l.verdict === 'up').length / set.length;
}

/**
 * Baseline #2: per-domain approval rate, LOO-excluding the target. A domain with no other graded
 * article falls back to the global majority prior (so singleton domains do not divide by zero).
 */
export function perDomainPUp(labeled: Labeled[], domain: string, excludeId?: string): number {
  const same = labeled.filter((l) => l.turn_id !== excludeId && l.domain === domain);
  if (same.length === 0) return majorityPUp(labeled, excludeId);
  return same.filter((l) => l.verdict === 'up').length / same.length;
}

export interface Scored {
  acc: number;
  brier: number;
}

export interface EvalResult {
  n: number;
  k: number;
  predictor: Scored;
  majority: Scored;
  perDomain: Scored;
  perItem: Array<{
    turn_id: string;
    domain: string;
    actual: Verdict;
    pUpPred: number;
    pUpMaj: number;
    pUpDom: number;
  }>;
}

const acc01 = (pUp: number, actualUp: number): number =>
  (pUp >= 0.5 ? 1 : 0) === actualUp ? 1 : 0;

/**
 * Leave-one-out eval over every labeled article, scoring the kNN predictor against both baselines.
 * Reports accuracy (thresholded at 0.5) AND Brier score (calibration: mean squared error of the
 * probability, lower is better). Accuracy says "did it pick the right side"; Brier says "was its
 * confidence honest".
 */
export function evaluateLOO(labeled: Labeled[], k: number): EvalResult {
  let accP = 0;
  let accM = 0;
  let accD = 0;
  let brP = 0;
  let brM = 0;
  let brD = 0;
  const perItem: EvalResult['perItem'] = [];

  for (const t of labeled) {
    const actualUp = t.verdict === 'up' ? 1 : 0;
    const pUpPred = knnPredict(t.vec, labeled, k, t.turn_id).pUp;
    const pUpMaj = majorityPUp(labeled, t.turn_id);
    const pUpDom = perDomainPUp(labeled, t.domain, t.turn_id);

    accP += acc01(pUpPred, actualUp);
    accM += acc01(pUpMaj, actualUp);
    accD += acc01(pUpDom, actualUp);
    brP += (pUpPred - actualUp) ** 2;
    brM += (pUpMaj - actualUp) ** 2;
    brD += (pUpDom - actualUp) ** 2;

    perItem.push({
      turn_id: t.turn_id,
      domain: t.domain,
      actual: t.verdict,
      pUpPred,
      pUpMaj,
      pUpDom,
    });
  }

  const n = labeled.length;
  return {
    n,
    k,
    predictor: { acc: accP / n, brier: brP / n },
    majority: { acc: accM / n, brier: brM / n },
    perDomain: { acc: accD / n, brier: brD / n },
    perItem,
  };
}

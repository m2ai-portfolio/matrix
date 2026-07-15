// Soundwave flywheel rung 1 — card-ranking helper (card Q-20260706-0005).
// Pure + embedder-injected, same discipline as predictor.ts: vectors in, predictions out, no DB and
// no network here so tests inject a deterministic fake embedder. run.ts wires the real Gemini
// embedder + DB loader around this; the Python digest generator shells out to
// `node dist/interest/run.js --mode rank-cards` and renders the result ADVISORY-only (rung 1: shown,
// never acted on — no reorder, no hide, no auto-grade).

import { knnPredict, type Labeled, type Verdict } from './predictor.js';

/** One discovered card the digest generator hands in (title + the summary text it already fetched). */
export interface CardInput {
  id: string;
  title: string;
  text: string;
}

/** A labeled point that also carries a human-readable title, for the nearest-exemplar explainer. */
export interface TitledLabeled extends Labeled {
  title: string;
}

export interface CardPrediction {
  pUp: number;
  verdict: Verdict;
  confidence: number;
  /** The closest already-graded article, surfaced for explainability (why this pick). */
  nearest_exemplar: { verdict: Verdict; title: string } | null;
}

/**
 * Rank a batch of discovered cards by predicted P(up) against the graded set. Embedding is injected
 * (realEmbedder in prod, a deterministic fake in tests). A card whose text is empty, or whose
 * embedding comes back empty, is SKIPPED rather than scored 0.5 — a failed embed must never
 * manufacture a fake "Top Pick". Callers treat a missing id as "no prediction for this card".
 */
export async function rankCards(
  cards: CardInput[],
  labeled: TitledLabeled[],
  embed: (text: string) => Promise<number[]>,
  k: number,
): Promise<Record<string, CardPrediction>> {
  const out: Record<string, CardPrediction> = {};
  for (const c of cards) {
    const text = `${c.title}\n${c.text}`.trim();
    if (!text) continue;
    const raw = await embed(text);
    if (!raw || raw.length === 0) continue; // failed/empty embed -> skip, never a bogus 0.5 pick
    const vec = new Float32Array(raw);
    const pred = knnPredict(vec, labeled, k);
    const nearest = pred.neighbors[0];
    const exemplar = nearest ? labeled.find((l) => l.turn_id === nearest.turn_id) : undefined;
    out[c.id] = {
      pUp: +pred.pUp.toFixed(3),
      verdict: pred.verdict,
      confidence: +pred.confidence.toFixed(3),
      nearest_exemplar: exemplar ? { verdict: exemplar.verdict, title: exemplar.title } : null,
    };
  }
  return out;
}

// Matrix Phase 2 — Mine semantic enricher (the concrete SemanticEnricher).
//
// Fills the long-dormant `MineConfig.semantic` seam: for a finding, probe the project's recent
// discussion and count the near-duplicate turns that live OUTSIDE its project, broken down by WHERE
// they recur (cross-source lanes like chatgpt/claude_ai, or other ~/projects repos). This is what
// makes the 166k-turn embedding index actually drive findings instead of sitting unused — "you're
// still circling this stale project, and the same topic shows up across N ChatGPT convos + repo X;
// go connect the threads."
//
// Multi-probe, not single-turn: it walks the recency-ordered candidate turn-ids and KNNs the first
// few that are EMBEDDED (skipping unembedded ones for free), unioning their cross-context neighbors
// deduped by turn_id. This matters because the single most-recent turn is often today's not-yet-
// embedded turn or a trivial tool result — probing one turn would frequently yield an empty (filler)
// finding, which the anti-slop design rejects.
//
// No network, no re-embedding: the corpus is already fully embedded, so the enricher reads each
// probe turn's STORED 3072-dim vector from the embedding table and runs KNN over the vec0 index.
// Turns with no stored vector are skipped — a Mine pass stays fast and side-effect-free.
//
// Calibration (live index, 2026-06-23): vectors are unit-normalized (L2 norm 1.0), so L2 distance
// d maps to cosine as cos = 1 - d^2/2. Genuine same-topic recurrence sits at d ~ 0.50-0.72; beyond
// ~0.73 neighbors drift into generic "AI agents" content. Hence the default maxDistance = 0.72.
// All knobs are configurable, and the count is bounded by k (no silent unbounded scan).
//
// Safety: reads only the warehouse handle it is given; never opens or touches claudeclaw.db. Pure
// over its inputs; all I/O goes through injectable seams so the unit tests are hermetic.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import { EMBED_MODEL, initVec, knn as vecKnn, type KnnHit } from '../db/vec.js';
import type { CrossContext, RecurrenceBucket, SemanticEnricher } from './mine-v1.js';

export interface SemanticEnricherOptions {
  /** Nearest neighbors to pull per probe before distance-filtering. Default 80. */
  k?: number;
  /**
   * Max L2 distance counted as "the same topic". Vectors are unit-normalized, so d <= 0.72 is
   * cosine >= ~0.74. Calibrated against the live index 2026-06-23. Lower = higher precision.
   */
  maxDistance?: number;
  /** Cap the where-breakdown to the top-N buckets (by count) for the headline. Default 4. */
  topBuckets?: number;
  /**
   * Max EMBEDDED probe turns to actually KNN from the candidate list. The candidates are recency-
   * ordered; unembedded ones are skipped (not counted against this budget) so the most-recent
   * still-unembedded turns don't starve the probe. Default 5.
   */
  maxProbes?: number;
  /** Test seam: stored 3072-dim vector for a turn, or undefined if not embedded. */
  getVector?: (turnId: string) => number[] | undefined;
  /** Test seam: KNN over the vec index. */
  knn?: (vec: number[], k: number) => KnnHit[];
  /** Test seam: project + source for a turn_id. */
  lookupTurn?: (turnId: string) => { project: string; source: string } | undefined;
  /**
   * Predicate: is this neighbor's context an ACTIONABLE place to go connect a thread? Default
   * rejects ephemeral CMD/worktree temp dirs (`-tmp-*`) and the bare uncategorized home bucket
   * (`-home-user`), which are not projects/conversations worth surfacing. Everything else —
   * named ~/projects repos and cross-source lanes (chatgpt/claude_ai/gemini/claudeclaw/...) — counts.
   */
  isActionable?: (project: string, source: string) => boolean;
}

/** Default actionable-context filter: drop ephemeral temp dirs and the uncategorized home bucket. */
export function defaultIsActionable(project: string): boolean {
  if (project === '') return true; // cross-source lane (bucketed by source) — always actionable
  if (project === '-home-user') return false; // uncategorized home claude_code sessions
  if (project.startsWith('-tmp-')) return false; // CMD mission / worktree temp dirs
  return true;
}

/** Decode a stored Float32 embedding blob back into a number[]. */
function decodeVector(buf: Buffer): number[] {
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f);
}

/**
 * Build a SemanticEnricher bound to the warehouse handle `db`. Seams default to the live
 * embedding table + vec0 index but are fully injectable for hermetic tests.
 */
export function createSemanticEnricher(
  db: Database,
  opts: SemanticEnricherOptions = {},
): SemanticEnricher {
  const k = opts.k ?? 80;
  const maxDistance = opts.maxDistance ?? 0.72;
  const topBuckets = opts.topBuckets ?? 4;
  const maxProbes = opts.maxProbes ?? 5;
  const isActionable = opts.isActionable ?? defaultIsActionable;

  // Lazily load the sqlite-vec extension + ensure the vec table only when we actually KNN, so an
  // un-embedded warehouse (e.g. a test temp DB) is never touched.
  let vecReady = false;
  const ensureVec = (): void => {
    if (!vecReady) {
      initVec(db);
      vecReady = true;
    }
  };

  const getVector =
    opts.getVector ??
    ((turnId: string): number[] | undefined => {
      const row = db
        .prepare('SELECT vector FROM embedding WHERE turn_id = ? AND model = ?')
        .get(turnId, EMBED_MODEL) as { vector: Buffer } | undefined;
      return row ? decodeVector(row.vector) : undefined;
    });

  const knnFn =
    opts.knn ??
    ((vec: number[], kk: number): KnnHit[] => {
      ensureVec();
      return vecKnn(db, vec, kk);
    });

  const lookupTurn =
    opts.lookupTurn ??
    ((turnId: string) =>
      db.prepare('SELECT project, source FROM conversation_turn WHERE turn_id = ?').get(turnId) as
        | { project: string; source: string }
        | undefined);

  return {
    async crossContextRecurrence(turnIds: string[], project: string): Promise<CrossContext> {
      // Probe up to maxProbes EMBEDDED turns from the recency-ordered candidates, unioning their
      // cross-context neighbors. A neighbor is counted ONCE across all probes (deduped by turn_id),
      // so the count is "distinct cross-context turns near this project's recent discussion", not an
      // inflated per-probe sum. The probe turns themselves are part of the project's own discussion,
      // so they (and any same-project neighbor) are excluded.
      const probeSet = new Set(turnIds);
      const neighborKey = new Map<string, string>(); // neighbor turn_id -> bucket key (first/closest wins)
      let probesUsed = 0;

      for (const turnId of turnIds) {
        if (probesUsed >= maxProbes) break;
        const vec = getVector(turnId);
        if (!vec) continue; // unembedded candidate: skip, don't spend the probe budget
        probesUsed += 1;

        for (const h of knnFn(vec, k)) {
          if (h.distance > maxDistance) continue; // not the same topic
          if (probeSet.has(h.turn_id)) continue; // a probe turn (the project's own discussion)
          if (neighborKey.has(h.turn_id)) continue; // already counted via a closer probe
          const n = lookupTurn(h.turn_id);
          if (!n) continue;
          // "Inside" = the same NAMED project. Cross-source rows (project='') are always outside.
          if (n.project !== '' && n.project === project) continue;
          if (!isActionable(n.project, n.source)) continue; // skip ephemeral/uncategorized contexts
          neighborKey.set(h.turn_id, n.project !== '' ? n.project : n.source);
        }
      }

      const tally = new Map<string, number>();
      for (const key of neighborKey.values()) tally.set(key, (tally.get(key) ?? 0) + 1);

      const buckets: RecurrenceBucket[] = [...tally.entries()]
        .map(([key, c]) => ({ key, count: c }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, topBuckets);

      return { count: neighborKey.size, buckets };
    },
  };
}

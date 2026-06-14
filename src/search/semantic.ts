// Matrix Phase 1 — cross-source semantic search.
// Spec claims: C-16, C-17, C-18, C-44.
//
// Embeds the query via the SAME injected embedder used by the worker (zero network in tests),
// runs a KNN over the vec0 index, and joins conversation_turn so each hit carries its source and
// content. Results may span BOTH source=claude_code and source=claudeclaw — the index is keyed by
// turn_id regardless of origin, so a single query naturally returns cross-source hits.

import type { Database } from 'better-sqlite3';
import type { Embedder } from '../embed/embedder.js';
import { knn } from '../db/vec.js';

export interface SearchHit {
  turn_id: string;
  source: string;
  content: string;
  score: number;
}

export interface SemanticSearchOptions {
  embedder: Embedder;
  k?: number;
}

/**
 * Embed `query`, KNN over the vec index, and return the top-k turns with source + score.
 * score = 1 / (1 + distance), so larger is closer and rank order matches ascending distance (C-17).
 */
export async function semanticSearch(
  db: Database,
  query: string,
  opts: SemanticSearchOptions,
): Promise<SearchHit[]> {
  const k = opts.k ?? 10;
  const queryVec = await opts.embedder(query); // injected; the only embed path (C-16/C-23)
  const hits = knn(db, queryVec, k);

  const lookup = db.prepare('SELECT source, content FROM conversation_turn WHERE turn_id = ?');
  const out: SearchHit[] = [];
  for (const h of hits) {
    const row = lookup.get(h.turn_id) as { source: string; content: string } | undefined;
    out.push({
      turn_id: h.turn_id,
      source: row?.source ?? '',
      content: row?.content ?? '',
      score: 1 / (1 + h.distance),
    });
  }
  return out;
}

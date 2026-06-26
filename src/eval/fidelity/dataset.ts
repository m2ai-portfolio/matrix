// Matrix v1 decision-fidelity eval: dataset loader.
// See ./CONTRACT.md. Loads the labeled Soundwave grades + their stored embedding vectors
// from the warehouse so the eval never re-embeds (the 3072-dim Float32 BLOBs already exist).
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';

export type Verdict = 'up' | 'down';

/** One labeled grade: an article, the owner's verdict + rationale, and its stored embedding. */
export interface Grade {
  turnId: string;
  content: string;
  verdict: Verdict;
  /** the owner's free-text rationale. LEAKS the verdict, so it is passed only as CONTEXT, never for the held-out item. */
  notes: string;
  domain: string;
  url: string;
  /** The 3072-dim embedding pulled straight from the embedding table (no re-embed). */
  vector: Float32Array;
}

/** Decode a stored embedding BLOB (little-endian Float32) into a Float32Array. */
export function decodeVector(blob: Buffer): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(
      `embedding BLOB length ${blob.byteLength} is not a multiple of 4 (expected Float32)`,
    );
  }
  // Copy into a fresh buffer so the Float32Array is not a view over a pooled Node Buffer.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

interface Row {
  turn_id: string;
  content: string | null;
  meta: string | null;
  vector: Buffer | null;
}

/**
 * Load every usable Soundwave grade from the warehouse: source='soundwave', a verdict in
 * {up,down}, and a non-null embedding. Rows missing any of those are skipped (a poller would
 * call them unusable). Pass the chosen embedding model to keep the vector space consistent.
 */
export function loadSoundwaveGrades(db: Database, model = 'gemini-embedding-001'): Grade[] {
  const rows = db
    .prepare(
      `SELECT t.turn_id AS turn_id, t.content AS content, t.meta AS meta, e.vector AS vector
         FROM conversation_turn t
         JOIN embedding e ON e.turn_id = t.turn_id AND e.model = ?
        WHERE t.source = 'soundwave'
        ORDER BY t.turn_id`,
    )
    .all(model) as Row[];

  const grades: Grade[] = [];
  for (const r of rows) {
    if (!r.meta || !r.vector) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(r.meta) as Record<string, unknown>;
    } catch {
      continue;
    }
    const verdict = meta.verdict;
    if (verdict !== 'up' && verdict !== 'down') continue;
    grades.push({
      turnId: r.turn_id,
      content: r.content ?? '',
      verdict,
      notes: typeof meta.notes === 'string' ? meta.notes : '',
      domain: typeof meta.domain === 'string' ? meta.domain : '',
      url: typeof meta.url === 'string' ? meta.url : '',
      vector: decodeVector(r.vector),
    });
  }
  return grades;
}

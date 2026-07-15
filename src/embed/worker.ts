// Matrix Phase 1 — resumable, idempotent embed worker.
// Spec claims: C-12, C-13, C-14, C-15, C-23, C-26, C-27, C-29, C-30.
//
// Finds conversation_turn rows that have no embedding for the canonical model, embeds each via the
// INJECTED embedder (a deterministic fake in tests — zero network), and writes the vector to BOTH
// the embedding table and the vec0 index inside a per-row transaction. The per-row commit IS the
// checkpoint: an interruption leaves completed rows durably done with no partial/duplicate state,
// and a resume simply re-queries for the still-unembedded rows.
//
// Concurrency: the network-bound embedder calls run in a bounded pool (opts.concurrency, default 1).
// DB writes stay synchronous and atomic (better-sqlite3). concurrency=1 is strictly sequential.
// The live backfill opts into a higher pool purely for throughput.

import type { Database } from 'better-sqlite3';
import type { Embedder } from './embedder.js';
import { EMBED_MODEL, EMBED_DIM, initVec, hasVec, upsertVec } from '../db/vec.js';

/**
 * turn_ids in conversation_turn with no embedding row for the given model (C-12).
 *
 * Excludes source='auq': the AUQ forced-choice eval lane stores its situations as conversation_turn
 * rows but embeds them ONLY under the distinct key `gemini-embedding-001#auq-situation` (see
 * src/eval/fidelity/auq-dataset.ts). Without this guard the canonical embed worker would treat those
 * rows as un-embedded, embed their situation text under the canonical model, and push them into the
 * matrix_vec conversation index, contaminating the most sensitive corpus. AUQ vectors must never
 * enter the canonical conversation space.
 */
export function findUnembedded(db: Database, model: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.turn_id AS turn_id
         FROM conversation_turn t
         LEFT JOIN embedding e ON e.turn_id = t.turn_id AND e.model = ?
        WHERE e.turn_id IS NULL AND t.source <> 'auq'`,
    )
    .all(model) as Array<{ turn_id: string }>;
  return rows.map((r) => r.turn_id);
}

export interface EmbedWorkerOptions {
  embedder: Embedder;
  /** Retained for API compatibility; the work list is now snapshotted once per invocation. */
  batchSize?: number;
  /** Optional cap on how many rows to embed this run (for gated batches). Undefined = all. */
  limit?: number;
  /** Bounded parallelism for the network-bound embedder calls. Default 1 (strict sequential). */
  concurrency?: number;
  /** Optional progress callback, invoked after each successful checkpoint with the running total. */
  onProgress?: (embedded: number) => void;
}

export interface EmbedWorkerResult {
  embedded: number;
  skipped: number;
}

/**
 * Embed every un-embedded turn via the injected embedder. Each row's embedding-table write + vec
 * upsert happen inside one transaction so the row is either fully embedded or not at all (C-14).
 * Re-running embeds 0 because findUnembedded no longer returns those rows (C-26/C-29).
 *
 * Per-row fault isolation: if the embedder throws for a single turn (rate limit, oversized input,
 * transient network error), that turn is logged and counted in skipped; the pool continues with
 * the remaining turns. The skipped row stays unembedded and is picked up on the next run (C-27).
 * Only a DB write error inside writeOne propagates and aborts the run.
 */
export async function runEmbedWorker(
  db: Database,
  opts: EmbedWorkerOptions,
): Promise<EmbedWorkerResult> {
  initVec(db);
  const { embedder, limit, onProgress } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const insertEmb = db.prepare(
    'INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)',
  );
  const getContent = db.prepare('SELECT content FROM conversation_turn WHERE turn_id = ?');
  const embExists = db.prepare('SELECT 1 AS x FROM embedding WHERE turn_id = ? AND model = ?');

  // One row = one checkpoint. Writing embedding + vec together is atomic (C-14).
  const writeOne = db.transaction((turnId: string, vec: number[]) => {
    if (embExists.get(turnId, EMBED_MODEL) !== undefined) return; // guard against a double-write
    const buf = Buffer.from(new Float32Array(vec).buffer);
    insertEmb.run(turnId, EMBED_MODEL, EMBED_DIM, buf);
    if (!hasVec(db, turnId)) upsertVec(db, turnId, vec);
  });

  // Snapshot the work list once. A fresh invocation re-queries, which is how resume works (C-27).
  // The hard `limit` slice caps the run so a concurrent pool can never overshoot it.
  let queue = findUnembedded(db, EMBED_MODEL);
  if (limit !== undefined) queue = queue.slice(0, Math.max(0, limit));

  let embedded = 0;
  let skipped = 0;
  let cursor = 0;

  // A pool worker: claim the next index, embed (the only await / network path, C-13/C-15/C-30),
  // then checkpoint synchronously. Embedder failures are per-row: log, increment skipped, continue.
  async function poolWorker(): Promise<void> {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= queue.length) return;
      const tid = queue[i];
      const row = getContent.get(tid) as { content: string } | undefined;
      const text = row?.content ?? '';
      let vec: number[];
      try {
        vec = await embedder(text);
      } catch (e) {
        // Per-row isolation: one bad turn (rate limit, oversized input, network error) is skipped.
        // The row stays unembedded and will be retried on the next refresh run.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[embed-worker] skip ${tid}: ${msg.slice(0, 140)}`);
        skipped += 1;
        continue;
      }
      if (vec.length !== EMBED_DIM) {
        // A real embedder returning a wrong-dim vector must not corrupt the index; skip loudly.
        skipped += 1;
        continue;
      }
      writeOne(tid, vec); // checkpoint
      embedded += 1;
      if (onProgress) onProgress(embedded);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => poolWorker()));

  return { embedded, skipped };
}

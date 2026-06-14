// Matrix Phase 1 — sqlite-vec index module.
// Spec claims: C-01, C-02, C-19, C-32, C-42.
//
// Wraps the sqlite-vec extension over a better-sqlite3 connection: loads the extension,
// creates a vec0 virtual table indexing the embedding table by turn_id at dim 3072, and
// exposes upsert / KNN / count helpers. Vectors cross the FFI boundary as Float32Array.

import type { Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/** Canonical embedding model + dimension for the warehouse (GROUND TRUTH 2026-06-14). */
export const EMBED_MODEL = 'gemini-embedding-001';
export const EMBED_DIM = 3072;

/** Name of the vec0 virtual table indexing the embedding table by turn_id. */
export const VEC_TABLE = 'matrix_vec';

/**
 * Load the sqlite-vec loadable extension into a better-sqlite3 connection (C-32).
 * Idempotent: the extension registers its functions/modules once per connection; calling
 * again is harmless because we only re-run the loader, which sqlite-vec tolerates.
 */
export function loadVec(db: Database): void {
  sqliteVec.load(db);
}

/**
 * Create the vec0 virtual table indexing embeddings by turn_id at dim EMBED_DIM (C-01).
 * IF NOT EXISTS so it applies idempotently.
 */
export function createVecTable(db: Database): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(` +
      `turn_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])`,
  );
}

/** Load the extension and ensure the vec table exists. Safe to call repeatedly. */
export function initVec(db: Database): void {
  loadVec(db);
  createVecTable(db);
}

/**
 * Convert a number[] to a Float32Array for the vec0 boundary, enforcing the dim guard (C-42):
 * a vector whose length is not EMBED_DIM is rejected so a wrong-dim embedding can never reach
 * the index and corrupt KNN.
 */
export function toFloat32(vec: number[]): Float32Array {
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(`embedding dim mismatch: expected ${EMBED_DIM}, got ${vec?.length}`);
  }
  return new Float32Array(vec);
}

/**
 * Upsert a vector for turn_id (idempotent per turn_id). sqlite-vec's vec0 virtual table does NOT
 * honour INSERT OR REPLACE on its PRIMARY KEY (it raises a UNIQUE constraint), so we DELETE then
 * INSERT. Both run inside an implicit statement sequence; callers already hold a transaction when
 * batching, so this stays atomic from the caller's perspective.
 */
export function upsertVec(db: Database, turnId: string, vec: number[]): void {
  const f32 = toFloat32(vec);
  db.prepare(`DELETE FROM ${VEC_TABLE} WHERE turn_id = ?`).run(turnId);
  db.prepare(`INSERT INTO ${VEC_TABLE}(turn_id, embedding) VALUES (?, ?)`).run(turnId, f32);
}

/** True if a vec row exists for turn_id. */
export function hasVec(db: Database, turnId: string): boolean {
  const row = db.prepare(`SELECT 1 AS x FROM ${VEC_TABLE} WHERE turn_id = ?`).get(turnId);
  return row !== undefined;
}

/** Number of rows in the vec index. */
export function vecCount(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number };
  return row.n;
}

export interface KnnHit {
  turn_id: string;
  distance: number;
}

/** K-nearest-neighbour query over the vec index; returns hits ordered by ascending distance (C-02). */
export function knn(db: Database, queryVec: number[], k: number): KnnHit[] {
  const f32 = toFloat32(queryVec);
  return db
    .prepare(
      `SELECT turn_id, distance FROM ${VEC_TABLE} ` +
        `WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(f32, k) as KnnHit[];
}

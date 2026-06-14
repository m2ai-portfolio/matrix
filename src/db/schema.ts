// Matrix Phase 0 — canonical warehouse schema (ARCHITECTURE §4).
// Builder implementation: CREATE TABLE IF NOT EXISTS statements.
//
// Spec claims this file is responsible for: C-03..C-07, C-10, C-23.
// NodeNext ESM: imports of this module use `import { applySchema } from './schema.js'` (C-32).

import type { Database } from 'better-sqlite3';

/**
 * The canonical schema statements. Each is CREATE TABLE IF NOT EXISTS so the
 * schema applies idempotently (C-10).
 *
 * conversation_turn columns (C-03), exactly 11, turn_id is the sole PRIMARY KEY:
 *   turn_id, source, source_id, ingestion_batch_id, conversation_id, ts,
 *   role, content, tokens, project, meta.
 */
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS conversation_turn (
    turn_id TEXT PRIMARY KEY,
    source TEXT,
    source_id TEXT,
    ingestion_batch_id TEXT,
    conversation_id TEXT,
    ts TIMESTAMP,
    role TEXT,
    content TEXT,
    tokens INT,
    project TEXT,
    meta JSON
  )`,
  `CREATE TABLE IF NOT EXISTS embedding (
    turn_id TEXT,
    model TEXT,
    dim INT,
    vector BLOB
  )`,
  `CREATE TABLE IF NOT EXISTS entity (
    turn_id TEXT,
    kind TEXT,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS link (
    src_turn_id TEXT,
    dst_turn_id TEXT,
    kind TEXT,
    weight REAL
  )`,
  `CREATE TABLE IF NOT EXISTS outcome (
    turn_id TEXT,
    fed_work BOOL,
    artifact_ref TEXT
  )`,
];

/**
 * SQL for the canonical conversation_turn table plus the empty
 * embedding/entity/link/outcome tables. All CREATE TABLE IF NOT EXISTS (C-10).
 *
 * Returned as a single string of statements so tests can introspect it.
 */
export function schemaSql(): string {
  return STATEMENTS.map((s) => `${s};`).join('\n\n');
}

/** Apply the full schema idempotently (C-10). Safe to call repeatedly. */
export function applySchema(db: Database): void {
  db.exec(schemaSql());
}

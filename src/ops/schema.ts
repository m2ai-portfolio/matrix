// Matrix Fleet Visibility — operational-lane schema (docs/FLEET-VISIBILITY.md §2).
//
// This is the OPERATIONAL lane: agent status + activity events across sources.
// It is deliberately SEPARATE from the analytical corpus (conversation_turn,
// memories, ...) and lives in its own store file so a LAN board can read fleet
// metadata without ever holding a handle to the sensitive corpus (§1 guardrail).
//
// NodeNext ESM: import as `import { applyOpsSchema } from './schema.js'`.

import type { Database } from 'better-sqlite3';

/**
 * Operational-lane tables, all CREATE TABLE IF NOT EXISTS so the schema applies
 * idempotently. Identity rule: agent_key = `${source}:${agent_id}` (solves the
 * "two Datas" problem — a CCOS Telegram Data and a CMD agent-data are distinct).
 */
const STATEMENTS: string[] = [
  // One row per known agent, regardless of source. Static-ish metadata.
  `CREATE TABLE IF NOT EXISTS agent_registry (
    agent_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT,
    role TEXT,
    model TEXT,
    provider TEXT,
    owner_human TEXT,
    endpoint TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`,

  // Latest status snapshot per agent (upsert by agent_key). Volatile.
  `CREATE TABLE IF NOT EXISTS agent_status (
    agent_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    today_turns INTEGER,
    today_cost REAL,
    last_seen INTEGER,
    updated_at INTEGER
  )`,

  // Append-only, hive_mind-shaped cross-source activity feed.
  `CREATE TABLE IF NOT EXISTS activity_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    action TEXT,
    summary TEXT,
    artifacts TEXT,
    created_at INTEGER NOT NULL
  )`,

  // Idempotency for re-runs of sync: identical events collapse via INSERT OR IGNORE.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_dedupe
    ON activity_event(source, agent_key, created_at, action, summary)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_agent
    ON activity_event(agent_key, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_source
    ON activity_event(source, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_time
    ON activity_event(created_at DESC)`,
];

/** The full operational-lane schema as one string (tests can introspect it). */
export function schemaSql(): string {
  return STATEMENTS.map((s) => `${s};`).join('\n\n');
}

/** Apply the operational schema idempotently. Safe to call repeatedly. */
export function applyOpsSchema(db: Database): void {
  db.exec(schemaSql());
}

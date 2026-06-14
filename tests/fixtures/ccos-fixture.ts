// Fixture builder: a tmp SQLite DB shaped like the live claudeclaw.db, with seeded
// memories / consolidations / conversation_log rows. NEVER the real DB (C-22).
// Some rows carry a real 3072 JSON embedding; some NULL; one malformed; one wrong-dim;
// one with an empty summary (to exercise the raw_text fallback).

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { EMBED_DIM } from '../../src/db/vec.js';

/** A deterministic 3072-length vector seeded by a single number, JSON-stringified. */
export function fixtureVecJson(seed: number, dim = EMBED_DIM): string {
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    // simple deterministic ramp; distinct per seed
    v[i] = Math.sin(seed + i * 0.001);
  }
  return JSON.stringify(v);
}

/** A deterministic 3072 vector as a plain number[] (for warehouse-side fixtures). */
export function fixtureVec(seed: number, dim = EMBED_DIM): number[] {
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i * 0.001);
  return v;
}

/**
 * Build a claudeclaw.db-shaped fixture at <dir>/ccos-fixture.db and return the path.
 * Mirrors the live column layout discovered 2026-06-14 (embedding TEXT JSON, 3072-dim).
 */
export function buildCcosFixture(dir: string): string {
  const path = join(dir, 'ccos-fixture.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'conversation',
      raw_text TEXT NOT NULL,
      summary TEXT NOT NULL,
      entities TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      connections TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      salience REAL NOT NULL DEFAULT 1.0,
      consolidated INTEGER NOT NULL DEFAULT 0,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      embedding_model TEXT DEFAULT 'embedding-001',
      superseded_by INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE consolidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      summary TEXT NOT NULL,
      insight TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      embedding TEXT,
      embedding_model TEXT DEFAULT 'embedding-001',
      agent_id TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      topic_id TEXT,
      source TEXT NOT NULL DEFAULT 'telegram',
      source_meeting_id TEXT,
      source_turn_id TEXT
    );
  `);

  const wrongDim = JSON.stringify(new Array(768).fill(0.1)); // C-42 wrong-dim

  const mem = db.prepare(
    `INSERT INTO memories (chat_id, source, raw_text, summary, embedding, created_at, accessed_at)
     VALUES (@chat_id, @source, @raw_text, @summary, @embedding, @created_at, @accessed_at)`,
  );
  // m1: normal, with a valid 3072 embedding
  mem.run({
    chat_id: 'c1',
    source: 'conversation',
    raw_text: 'raw one',
    summary: 'summary one',
    embedding: fixtureVecJson(1),
    created_at: 1000,
    accessed_at: 1000,
  });
  // m2: NULL embedding (C-40)
  mem.run({
    chat_id: 'c1',
    source: 'conversation',
    raw_text: 'raw two',
    summary: 'summary two',
    embedding: null,
    created_at: 1001,
    accessed_at: 1001,
  });
  // m3: malformed embedding (C-41)
  mem.run({
    chat_id: 'c1',
    source: 'conversation',
    raw_text: 'raw three',
    summary: 'summary three',
    embedding: 'not json at all',
    created_at: 1002,
    accessed_at: 1002,
  });
  // m4: wrong-dim embedding (C-42)
  mem.run({
    chat_id: 'c1',
    source: 'conversation',
    raw_text: 'raw four',
    summary: 'summary four',
    embedding: wrongDim,
    created_at: 1003,
    accessed_at: 1003,
  });
  // m5: empty summary -> falls back to raw_text (C-43)
  mem.run({
    chat_id: 'c1',
    source: 'conversation',
    raw_text: 'fallback body',
    summary: '   ',
    embedding: null,
    created_at: 1004,
    accessed_at: 1004,
  });

  const con = db.prepare(
    `INSERT INTO consolidations (chat_id, source_ids, summary, insight, embedding, created_at)
     VALUES (@chat_id, @source_ids, @summary, @insight, @embedding, @created_at)`,
  );
  // cons1: summary + insight, valid embedding
  con.run({
    chat_id: 'c1',
    source_ids: '[1,2]',
    summary: 'cons summary',
    insight: 'cons insight',
    embedding: fixtureVecJson(2),
    created_at: 2000,
  });
  // cons2: no embedding
  con.run({
    chat_id: 'c1',
    source_ids: '[3]',
    summary: 'cons summary 2',
    insight: 'cons insight 2',
    embedding: null,
    created_at: 2001,
  });

  const log = db.prepare(
    `INSERT INTO conversation_log (chat_id, session_id, role, content, created_at, source)
     VALUES (@chat_id, @session_id, @role, @content, @created_at, @source)`,
  );
  log.run({
    chat_id: 'c1',
    session_id: 's1',
    role: 'user',
    content: 'log user msg',
    created_at: 3000,
    source: 'telegram',
  });
  log.run({
    chat_id: 'c1',
    session_id: 's1',
    role: 'assistant',
    content: 'log assistant msg',
    created_at: 3001,
    source: 'telegram',
  });

  db.close();
  return path;
}

/** Expected counts derived from the seed above. */
export const FIXTURE = {
  memories: 5,
  consolidations: 2,
  conversationLog: 2,
  // total turns ingested = 5 + 2 + 2
  totalTurns: 9,
  // rows with a VALID 3072 embedding: m1 + cons1 = 2
  validEmbeddings: 2,
} as const;

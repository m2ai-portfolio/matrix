// Matrix Phase 1 — READ-ONLY CCOS connector.
// Spec claims: C-03..C-11, C-20, C-22, C-24, C-25, C-40..C-43, C-51.
// NEVER writes to the CCOS source DB (opened mode=ro). Tests use a FIXTURE copy.
//
// Ingests the three CCOS tables (memories, consolidations, conversation_log) into the warehouse
// conversation_turn table as source=claudeclaw, reusing the Phase 0 content-hash for dedupe. Where
// a source row already carries a JSON embedding of exactly EMBED_DIM, it is loaded into the
// embedding table and the vec0 index. Idempotent: a second pass inserts 0 turns and loads 0
// embeddings. NOTE since the 2026-07-12 model migration (EMBED_DIM 3072 -> 4096): CCOS still
// stores 3072-dim gemini vectors, so the dim guard now rejects them by design; CCOS turns ingest
// normally and the embed worker re-embeds them under the new model like any other turn.

import Database from 'better-sqlite3';
import { applySchema } from '../db/schema.js';
import { turnId } from './claude-code.js';
import { EMBED_MODEL, EMBED_DIM, initVec, hasVec, upsertVec } from '../db/vec.js';

const SOURCE = 'claudeclaw';

/** Open the CCOS source DB strictly read-only (C-20/C-21/C-51). A write attempt will throw. */
export function openCcosReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

/**
 * Parse a CCOS embedding TEXT column (JSON float array) into a number[] (C-09).
 * Returns null for null/undefined/empty, malformed JSON, a non-array, or a length that is not
 * EMBED_DIM — so a null/malformed/wrong-dim embedding never loads (C-40/C-41/C-42).
 */
export function parseEmbedding(text: unknown): number[] | null {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') return null;
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length !== EMBED_DIM) return null;
  for (const x of parsed) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  }
  return parsed as number[];
}

export interface CcosIngestResult {
  turnsInserted: number;
  embeddingsLoaded: number;
  seen: number;
}

/** Internal: a normalized turn plus the optional embedding to load for it. */
interface SourceTurn {
  source_id: string;
  conversation_id: string;
  role: string;
  content: string;
  ts: string;
  ccosTable: string;
  ccosId: number;
  embedding: number[] | null;
}

/** Pick the first non-empty (trimmed) string, else ''. */
function firstNonEmpty(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return '';
}

interface MemoryRow {
  id: number;
  chat_id: string;
  raw_text: string;
  summary: string;
  embedding: unknown;
  created_at: number;
}
interface ConsolidationRow {
  id: number;
  chat_id: string;
  summary: string;
  insight: string;
  embedding: unknown;
  created_at: number;
}
interface ConvLogRow {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

/** Map a memories row → SourceTurn. content = summary, falling back to raw_text (C-04/C-43). */
function fromMemory(r: MemoryRow): SourceTurn {
  return {
    source_id: `memories:${r.id}`,
    conversation_id: r.chat_id,
    role: 'memory',
    content: firstNonEmpty(r.summary, r.raw_text),
    ts: String(r.created_at),
    ccosTable: 'memories',
    ccosId: r.id,
    embedding: parseEmbedding(r.embedding),
  };
}

/** Map a consolidations row → SourceTurn. content = summary + insight (C-05). */
function fromConsolidation(r: ConsolidationRow): SourceTurn {
  const content = [r.summary, r.insight].filter((s) => s && s.trim() !== '').join('\n\n');
  return {
    source_id: `consolidations:${r.id}`,
    conversation_id: r.chat_id,
    role: 'consolidation',
    content,
    ts: String(r.created_at),
    ccosTable: 'consolidations',
    ccosId: r.id,
    embedding: parseEmbedding(r.embedding),
  };
}

/** Map a conversation_log row → SourceTurn. content = content, role carried (C-06). */
function fromConvLog(r: ConvLogRow): SourceTurn {
  return {
    source_id: `conversation_log:${r.id}`,
    conversation_id: r.chat_id,
    role: r.role,
    content: r.content,
    ts: String(r.created_at),
    ccosTable: 'conversation_log',
    ccosId: r.id,
    embedding: null, // conversation_log has no embedding column
  };
}

/** Read all SourceTurns from the read-only CCOS DB. */
function readSourceTurns(ro: Database.Database): SourceTurn[] {
  const turns: SourceTurn[] = [];
  const memories = ro
    .prepare('SELECT id, chat_id, raw_text, summary, embedding, created_at FROM memories')
    .all() as MemoryRow[];
  for (const m of memories) turns.push(fromMemory(m));

  const cons = ro
    .prepare('SELECT id, chat_id, summary, insight, embedding, created_at FROM consolidations')
    .all() as ConsolidationRow[];
  for (const c of cons) turns.push(fromConsolidation(c));

  const logs = ro
    .prepare('SELECT id, chat_id, session_id, role, content, created_at FROM conversation_log')
    .all() as ConvLogRow[];
  for (const l of logs) turns.push(fromConvLog(l));

  return turns;
}

/**
 * Ingest the three CCOS tables from the read-only source at `ccosRoPath` into the warehouse `db`.
 * Reuses Phase 0 turnId() for content-hash dedupe (C-08); INSERT OR IGNORE on the PK gives
 * idempotency (C-24). Pre-existing valid embeddings load into embedding + vec idempotently
 * (C-09/C-10/C-11/C-25).
 */
export function ingestCcos(db: Database.Database, ccosRoPath: string): CcosIngestResult {
  applySchema(db); // ensure warehouse tables exist
  initVec(db); // ensure vec extension + table

  const ro = openCcosReadonly(ccosRoPath);
  let sources: SourceTurn[];
  try {
    sources = readSourceTurns(ro);
  } finally {
    ro.close();
  }

  const insertTurnStmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id, ts, role, content, tokens, project, meta)
     VALUES
       (@turn_id, @source, @source_id, @ingestion_batch_id, @conversation_id, @ts, @role, @content, @tokens, @project, @meta)`,
  );
  const embExistsStmt = db.prepare('SELECT 1 AS x FROM embedding WHERE turn_id = ? AND model = ?');
  const insertEmbStmt = db.prepare(
    'INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)',
  );

  let turnsInserted = 0;
  let embeddingsLoaded = 0;
  let seen = 0;

  const run = db.transaction((rows: SourceTurn[]) => {
    for (const s of rows) {
      seen++;
      const tid = turnId({
        source: SOURCE,
        source_id: s.source_id,
        conversation_id: s.conversation_id,
        role: s.role,
        content: s.content,
      });
      const meta = JSON.stringify({ ccos_table: s.ccosTable, ccos_id: s.ccosId });
      const res = insertTurnStmt.run({
        turn_id: tid,
        source: SOURCE,
        source_id: s.source_id,
        ingestion_batch_id: ccosRoPath,
        conversation_id: s.conversation_id,
        ts: s.ts,
        role: s.role,
        content: s.content,
        tokens: null,
        project: s.ccosTable,
        meta,
      });
      if (res.changes === 1) turnsInserted++;

      // Load a pre-existing valid embedding once (idempotent on (turn_id, model)).
      if (s.embedding !== null) {
        const exists = embExistsStmt.get(tid, EMBED_MODEL) !== undefined;
        if (!exists) {
          const buf = Buffer.from(new Float32Array(s.embedding).buffer);
          insertEmbStmt.run(tid, EMBED_MODEL, EMBED_DIM, buf);
          if (!hasVec(db, tid)) upsertVec(db, tid, s.embedding);
          embeddingsLoaded++;
        }
      }
    }
  });
  run(sources);

  return { turnsInserted, embeddingsLoaded, seen };
}

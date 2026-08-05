// Matrix fleet-memory layer — pure logic behind the matrix-memory MCP server.
// Turns the analytics warehouse into the fleet's shared long-term memory:
//   search   — semantic KNN over every ingested turn (all sources)
//   remember — append-only agent learning into the 'fleet_memory' source lane,
//              embedded immediately so other agents see it on their next search
//   recent   — newest fleet memories (the passive hive-mind glance)
//
// Writes NEVER touch ingested history: fleet_memory is its own source lane, purgeable
// with one DELETE. The embedder is injected (repo seam C-15/C-23) so tests stay
// zero-network.

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { Embedder } from '../embed/embedder.js';
import { semanticSearch, type SearchHit } from '../search/semantic.js';
import { EMBED_MODEL, EMBED_DIM, upsertVec } from '../db/vec.js';

export const FLEET_SOURCE = 'fleet_memory';

export interface RememberInput {
  agent: string;
  text: string;
  topic?: string;
  now?: () => string; // injectable clock for tests
}

export interface FleetMemory {
  turn_id: string;
  agent: string;
  topic: string;
  content: string;
  ts: string;
}

export interface SearchOptions {
  k?: number;
  source?: string;
}

/** Semantic search across the whole warehouse, optionally filtered to one source lane. */
export async function search(
  db: Database,
  query: string,
  embedder: Embedder,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  // Over-fetch when filtering so a sparse lane still returns k hits.
  const k = opts.k ?? 8;
  const hits = await semanticSearch(db, query, { embedder, k: opts.source ? k * 5 : k });
  const filtered = opts.source ? hits.filter((h) => h.source === opts.source) : hits;
  return filtered.slice(0, k);
}

/**
 * Append an agent learning into the fleet_memory lane and embed it immediately.
 * Idempotent per (agent, text): the turn_id is a content hash, so re-remembering
 * the same fact updates in place instead of duplicating.
 */
export async function remember(
  db: Database,
  embedder: Embedder,
  input: RememberInput,
): Promise<FleetMemory> {
  const agent = input.agent.trim();
  const text = input.text.trim();
  if (!agent) throw new Error('remember: agent is required');
  if (!text) throw new Error('remember: text is required');
  const topic = input.topic?.trim() ?? '';
  const ts = (input.now ?? (() => new Date().toISOString()))();
  const turnId =
    'fm-' + createHash('sha256').update(`${agent}\n${text}`).digest('hex').slice(0, 24);

  const vec = await embedder(text);
  if (vec.length !== EMBED_DIM) {
    throw new Error(`remember: embedder returned dim ${vec.length}, expected ${EMBED_DIM}`);
  }

  const insertTurn = db.prepare(
    `INSERT INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id, ts, role, content, tokens, project, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id) DO UPDATE SET content = excluded.content, ts = excluded.ts, meta = excluded.meta`,
  );
  const insertEmbedding = db.prepare(
    `INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)`,
  );
  const deleteEmbedding = db.prepare(`DELETE FROM embedding WHERE turn_id = ? AND model = ?`);

  const write = db.transaction(() => {
    insertTurn.run(
      turnId,
      FLEET_SOURCE,
      agent,
      'mcp-remember',
      `fleet:${agent}`,
      ts,
      'agent',
      text,
      null,
      topic,
      JSON.stringify({ agent, topic }),
    );
    deleteEmbedding.run(turnId, EMBED_MODEL);
    insertEmbedding.run(turnId, EMBED_MODEL, EMBED_DIM, Buffer.from(new Float32Array(vec).buffer));
    upsertVec(db, turnId, vec);
  });
  write();

  return { turn_id: turnId, agent, topic, content: text, ts };
}

/** Newest fleet memories, optionally filtered by agent. */
export function recent(db: Database, n = 20, agent?: string): FleetMemory[] {
  const rows = agent
    ? db
        .prepare(
          `SELECT turn_id, source_id, project, content, ts FROM conversation_turn
           WHERE source = ? AND source_id = ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(FLEET_SOURCE, agent, n)
    : db
        .prepare(
          `SELECT turn_id, source_id, project, content, ts FROM conversation_turn
           WHERE source = ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(FLEET_SOURCE, n);
  return (rows as Array<Record<string, string>>).map((r) => ({
    turn_id: r.turn_id,
    agent: r.source_id,
    topic: r.project,
    content: r.content,
    ts: r.ts,
  }));
}

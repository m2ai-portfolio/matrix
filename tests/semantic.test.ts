// Semantic search tests — embed query via injected embedder, KNN, return top-k with source+score,
// spanning BOTH sources.
// Claims: C-16, C-17, C-18, C-44.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, upsertVec, EMBED_MODEL } from '../src/db/vec.js';
import { semanticSearch } from '../src/search/semantic.js';
import { makeFakeEmbedder, vectorForText } from './helpers/fake-embedder.js';

let db: Database.Database;

function addTurn(turn_id: string, source: string, content: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_turn (turn_id, source, content) VALUES (?, ?, ?)`,
  ).run(turn_id, source, content);
  const v = vectorForText(content);
  db.prepare('INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)').run(
    turn_id,
    EMBED_MODEL,
    3072,
    Buffer.from(new Float32Array(v).buffer),
  );
  upsertVec(db, turn_id, v);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  initVec(db);
  // two sources, distinct content so their fake vectors differ
  addTurn('cc1', 'claude_code', 'matrix warehouse design notes');
  addTurn('cc2', 'claude_code', 'unrelated claude code chatter about builds');
  addTurn('cl1', 'claudeclaw', 'claudeclaw memory about the warehouse plan');
  addTurn('cl2', 'claudeclaw', 'claudeclaw telegram greeting hello');
});

afterEach(() => {
  db.close();
});

describe('semanticSearch (C-16/C-17/C-18/C-44)', () => {
  it('C-16/C-17: embeds query via injected embedder; returns top-k with turn_id, source, content, score', async () => {
    const fake = makeFakeEmbedder();
    // query identical to cc1 content -> cc1 should rank first (its fake vector matches exactly)
    const hits = await semanticSearch(db, 'matrix warehouse design notes', {
      embedder: fake.embedder,
      k: 4,
    });
    expect(fake.count()).toBe(1); // exactly one query embed
    expect(hits.length).toBe(4);
    expect(hits[0].turn_id).toBe('cc1');
    expect(hits[0]).toHaveProperty('source');
    expect(hits[0]).toHaveProperty('content');
    expect(typeof hits[0].score).toBe('number');
    // score is larger-is-closer: rank 1 score >= rank 2 score
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it('C-18/C-44: a single query returns rows spanning BOTH sources', async () => {
    const fake = makeFakeEmbedder();
    const hits = await semanticSearch(db, 'matrix warehouse design notes', {
      embedder: fake.embedder,
      k: 4,
    });
    const sources = new Set(hits.map((h) => h.source));
    expect(sources.has('claude_code')).toBe(true);
    expect(sources.has('claudeclaw')).toBe(true);
  });
});

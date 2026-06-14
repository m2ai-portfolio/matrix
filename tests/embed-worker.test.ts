// Embed worker tests — finds unembedded rows, calls the INJECTED embedder, writes embedding+vec,
// is idempotent on re-run, and resumes after a mid-run interruption with no duplicate rows.
// Claims: C-12, C-13, C-14, C-15, C-23, C-26, C-27, C-29.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, vecCount, EMBED_MODEL } from '../src/db/vec.js';
import { findUnembedded, runEmbedWorker } from '../src/embed/worker.js';
import { makeFakeEmbedder, makeThrowingEmbedder } from './helpers/fake-embedder.js';

let db: Database.Database;

function insertTurn(turn_id: string, source = 'claude_code', content = `c-${turn_id}`): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_turn (turn_id, source, content) VALUES (?, ?, ?)`,
  ).run(turn_id, source, content);
}
function embCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM embedding').get() as { n: number }).n;
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  initVec(db);
  for (let i = 0; i < 5; i++) insertTurn(`t${i}`);
});

afterEach(() => {
  db.close();
});

describe('findUnembedded (C-12)', () => {
  it('C-12: returns turns with no embedding row for the model', () => {
    expect(findUnembedded(db, EMBED_MODEL).sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
    // pre-embed one
    db.prepare('INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)').run(
      't0',
      EMBED_MODEL,
      3072,
      Buffer.from([1]),
    );
    expect(findUnembedded(db, EMBED_MODEL).sort()).toEqual(['t1', 't2', 't3', 't4']);
  });
});

describe('runEmbedWorker (C-13/C-14/C-15/C-23/C-26)', () => {
  it('C-13/C-14/C-15: embeds every un-embedded row via injected embedder, writes embedding + vec', async () => {
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder, batchSize: 2 });
    expect(res.embedded).toBe(5);
    expect(fake.count()).toBe(5); // C-13 one call per row
    expect(embCount()).toBe(5); // C-14 embedding table written
    expect(vecCount(db)).toBe(5); // C-14 vec index written
  });

  it('C-26: a re-run embeds 0 (idempotent)', async () => {
    const fake = makeFakeEmbedder();
    await runEmbedWorker(db, { embedder: fake.embedder });
    const fake2 = makeFakeEmbedder();
    const res2 = await runEmbedWorker(db, { embedder: fake2.embedder });
    expect(res2.embedded).toBe(0);
    expect(fake2.count()).toBe(0);
    expect(embCount()).toBe(5);
    expect(vecCount(db)).toBe(5);
  });
});

describe('bounded concurrency (live-run throughput)', () => {
  it('concurrency > 1 embeds every row and is idempotent on re-run', async () => {
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder, concurrency: 4 });
    expect(res.embedded).toBe(5);
    expect(fake.count()).toBe(5);
    expect(embCount()).toBe(5);
    expect(vecCount(db)).toBe(5);

    const fake2 = makeFakeEmbedder();
    const res2 = await runEmbedWorker(db, { embedder: fake2.embedder, concurrency: 4 });
    expect(res2.embedded).toBe(0);
    expect(embCount()).toBe(5);
  });

  it('a hard limit caps the run even under concurrency (no overshoot)', async () => {
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder, concurrency: 4, limit: 3 });
    expect(res.embedded).toBe(3);
    expect(embCount()).toBe(3);
    expect(vecCount(db)).toBe(3);
  });
});

describe('interruption + resume (C-27/C-29)', () => {
  it('C-27/C-29: mid-run interruption checkpoints partial work; resume finishes with no duplicates', async () => {
    // embedder throws after 2 successful rows
    const throwing = makeThrowingEmbedder(2);
    await expect(runEmbedWorker(db, { embedder: throwing.embedder })).rejects.toThrow();

    // exactly 2 rows checkpointed; embedding count == vec count (no partial/dupe)
    expect(embCount()).toBe(2);
    expect(vecCount(db)).toBe(2);

    // resume with a working embedder: embeds only the remaining 3, no duplicates
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder });
    expect(res.embedded).toBe(3);
    expect(fake.count()).toBe(3);
    expect(embCount()).toBe(5); // C-29 no dup rows
    expect(vecCount(db)).toBe(5);
  });
});

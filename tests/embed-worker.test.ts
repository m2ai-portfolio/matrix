// Embed worker tests — finds unembedded rows, calls the INJECTED embedder, writes embedding+vec,
// is idempotent on re-run, and resumes after a mid-run interruption with no duplicate rows.
// Claims: C-12, C-13, C-14, C-15, C-23, C-26, C-27, C-29.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, vecCount, EMBED_MODEL } from '../src/db/vec.js';
import { findUnembedded, runEmbedWorker } from '../src/embed/worker.js';
import {
  makeFakeEmbedder,
  makeThrowingEmbedder,
  makeTargetedThrowEmbedder,
  vectorForText,
} from './helpers/fake-embedder.js';
import type { Embedder } from '../src/embed/embedder.js';
import { withContextFallback } from '../src/embed/embedder.js';
import { withRetry } from '../src/refresh/run.js';

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

describe('source=auq isolation (AUQ eval rows never enter the canonical index)', () => {
  it('findUnembedded excludes source=auq rows', () => {
    insertTurn('auq:x:0', 'auq', 'a situation');
    // the 5 claude_code turns are unembedded, but the auq row must not appear
    expect(findUnembedded(db, EMBED_MODEL)).not.toContain('auq:x:0');
    expect(findUnembedded(db, EMBED_MODEL).sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('runEmbedWorker never embeds an auq row under the canonical model or into vec', async () => {
    insertTurn('auq:x:0', 'auq', 'a situation');
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder });
    expect(res.embedded).toBe(5); // only the 5 conversation turns
    const auqCanonical = db
      .prepare('SELECT COUNT(*) AS n FROM embedding WHERE turn_id = ? AND model = ?')
      .get('auq:x:0', EMBED_MODEL) as { n: number };
    expect(auqCanonical.n).toBe(0); // no canonical embedding for the auq row
    expect(vecCount(db)).toBe(5); // auq row not in the vec0 index
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

describe('per-row fault isolation (C-27/C-29)', () => {
  it('C-27: embedder failure on later rows skips those rows; earlier rows stay committed', async () => {
    // throwing embedder succeeds for t0/t1, then throws for every subsequent row
    const throwing = makeThrowingEmbedder(2);
    const res = await runEmbedWorker(db, { embedder: throwing.embedder });
    // run completes without throwing; first 2 rows embedded, rest skipped
    expect(res.embedded).toBe(2);
    expect(res.skipped).toBe(3);
    expect(embCount()).toBe(2);
    expect(vecCount(db)).toBe(2);
  });

  it('C-29: a subsequent run with a working embedder embeds skipped rows with no duplicates', async () => {
    const throwing = makeThrowingEmbedder(2);
    await runEmbedWorker(db, { embedder: throwing.embedder });

    // resume: only the 3 still-unembedded rows are picked up
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder });
    expect(res.embedded).toBe(3);
    expect(fake.count()).toBe(3);
    expect(embCount()).toBe(5); // no duplicates
    expect(vecCount(db)).toBe(5);
  });

  it('single bad row does not abort the pass (core regression test)', async () => {
    // targeted throw: t2 (content "c-t2") throws; all other rows succeed
    const targeted = makeTargetedThrowEmbedder('c-t2');
    const res = await runEmbedWorker(db, { embedder: targeted.embedder });
    expect(res.embedded).toBe(4); // t0, t1, t3, t4
    expect(res.skipped).toBe(1); // t2
    expect(embCount()).toBe(4);
    expect(vecCount(db)).toBe(4);
  });
});

describe('Part 2: context-length truncation (withContextFallback)', () => {
  it('a 400 context-length error triggers input halving until the row embeds', async () => {
    // fake: throws "context length" for inputs > 100 chars; succeeds on shorter inputs
    const contextFake: Embedder = async (text: string): Promise<number[]> => {
      if (text.length > 100)
        throw new Error('You passed 40961 input tokens, context length is only 40960');
      return vectorForText(text);
    };
    const wrapped = withContextFallback(contextFake);
    // 500-char row: 500 -> 250 -> 125 -> 62 chars; succeeds at 62 (halved 3 times, < 100)
    db.prepare(
      `INSERT OR IGNORE INTO conversation_turn (turn_id, source, content) VALUES (?, ?, ?)`,
    ).run('big', 'claude_code', 'x'.repeat(500));
    const res = await runEmbedWorker(db, { embedder: wrapped });
    expect(res.embedded).toBe(6); // 5 regular turns + 1 big turn (truncated)
    expect(res.skipped).toBe(0);
    expect(embCount()).toBe(6);
    const bigRow = db.prepare('SELECT 1 FROM embedding WHERE turn_id = ?').get('big');
    expect(bigRow).toBeDefined();
  });
});

describe('Part 3: retry discrimination + production composition (regression for the 2026-07-14 poison rows)', () => {
  // A live embed of the two 200k-char claude_code poison rows showed the 60k slice tokenizes to
  // 40961 tokens (1 over Qwen's 40960 limit), so the endpoint returns a deterministic 400. The bug:
  // withRetry retried that 400 up to 10x (~2 min of backoff) BEFORE withContextFallback could halve.
  // These tests pin the fix: a 400 fails fast, a 429 still retries, and the composed path truncates
  // without burning the retry budget.
  it('withRetry retries a transient 429 but fails fast on a deterministic 400', async () => {
    let calls429 = 0;
    const flaky429: Embedder = async (text: string): Promise<number[]> => {
      calls429 += 1;
      if (calls429 < 2) throw new Error('DeepInfra embed HTTP 429: rate limited, please retry');
      return vectorForText(text);
    };
    await withRetry(flaky429, 5)('hello');
    expect(calls429).toBe(2); // one retry, then success — a transient error IS retried

    let calls400 = 0;
    const bad400: Embedder = async (): Promise<number[]> => {
      calls400 += 1;
      throw new Error(
        'DeepInfra embed HTTP 400: You passed 40961 input tokens, context length is only 40960',
      );
    };
    await expect(withRetry(bad400, 10)('hello')).rejects.toThrow(/400/);
    expect(calls400).toBe(1); // a deterministic 400 is NOT retried — one call, then propagate
  });

  it('withContextFallback(withRetry(...)) truncates an oversized row without burning retries', async () => {
    let calls = 0;
    // realEmbedder-style: 400s while the input the endpoint sees is too long; succeeds once short.
    const fake: Embedder = async (text: string): Promise<number[]> => {
      calls += 1;
      if (text.length > 100)
        throw new Error(
          'DeepInfra embed HTTP 400: You passed 40961 input tokens, context length is only 40960',
        );
      return vectorForText(text);
    };
    const composed = withContextFallback(withRetry(fake, 10)); // the exact production shape
    const vec = await composed('x'.repeat(500));
    expect(vec.length).toBeGreaterThan(0);
    // 500 -> 250 -> 125 -> 62: exactly one call per halving because the 400 is not retried.
    // If withRetry retried the 400, this would be up to ~10x more calls.
    expect(calls).toBe(4);
  });
});

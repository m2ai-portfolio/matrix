// KEYSTONE tests — vec count == embedding count after a run; cross-component idempotency;
// the worker never calls the real embedder and the 122k live run is out of scope.
// Claims: C-28, C-29, C-30.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, vecCount } from '../src/db/vec.js';
import { ingestCcos } from '../src/connectors/ccos.js';
import { runEmbedWorker } from '../src/embed/worker.js';
import { buildCcosFixture } from './fixtures/ccos-fixture.js';
import { makeFakeEmbedder } from './helpers/fake-embedder.js';
import { makeTmpDir, cleanupTmpDir } from './helpers/tmp.js';

let tmpDir: string;
let ccosPath: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = makeTmpDir();
  ccosPath = buildCcosFixture(tmpDir);
  db = new Database(':memory:');
  applySchema(db);
  initVec(db);
});

afterEach(() => {
  db.close();
  cleanupTmpDir(tmpDir);
});

function embCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM embedding').get() as { n: number }).n;
}
function turnCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM conversation_turn').get() as { n: number }).n;
}

describe('keystone (C-28/C-29/C-30)', () => {
  it('C-28: after connector + worker, vec index row count == embedding table row count', async () => {
    ingestCcos(db, ccosPath);
    const fake = makeFakeEmbedder();
    await runEmbedWorker(db, { embedder: fake.embedder });
    expect(vecCount(db)).toBe(embCount());
    // and every turn now has an embedding (connector-loaded + worker-filled)
    expect(embCount()).toBe(turnCount());
  });

  it('C-29: cross-component idempotency — connector→worker→connector→worker leaves identical counts', async () => {
    ingestCcos(db, ccosPath);
    await runEmbedWorker(db, { embedder: makeFakeEmbedder().embedder });
    const t1 = turnCount();
    const e1 = embCount();
    const v1 = vecCount(db);

    ingestCcos(db, ccosPath);
    const res2 = await runEmbedWorker(db, { embedder: makeFakeEmbedder().embedder });
    expect(res2.embedded).toBe(0);
    expect(turnCount()).toBe(t1);
    expect(embCount()).toBe(e1);
    expect(vecCount(db)).toBe(v1);
  });

  it('C-30: the worker only ever calls the INJECTED embedder (no real/live embed in the loop)', async () => {
    ingestCcos(db, ccosPath);
    const fake = makeFakeEmbedder();
    const res = await runEmbedWorker(db, { embedder: fake.embedder });
    // every embed performed went through the injected fake; none bypassed to a real call
    expect(fake.count()).toBe(res.embedded);
    expect(res.embedded).toBeGreaterThan(0);
  });
});

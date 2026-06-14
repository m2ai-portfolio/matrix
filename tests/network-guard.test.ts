// Network guard — arms a global fetch stub that throws if hit, then runs the full flow
// (connector + worker + semantic) with a fake embedder. ZERO network must occur.
// Claims: C-23.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec } from '../src/db/vec.js';
import { ingestCcos } from '../src/connectors/ccos.js';
import { runEmbedWorker } from '../src/embed/worker.js';
import { semanticSearch } from '../src/search/semantic.js';
import { buildCcosFixture } from './fixtures/ccos-fixture.js';
import { makeFakeEmbedder } from './helpers/fake-embedder.js';
import { makeTmpDir, cleanupTmpDir } from './helpers/tmp.js';

let tmpDir: string;
let ccosPath: string;
let db: Database.Database;
let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = makeTmpDir();
  ccosPath = buildCcosFixture(tmpDir);
  db = new Database(':memory:');
  applySchema(db);
  initVec(db);

  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(() => {
    throw new Error('network access is forbidden in the build/test loop (C-23)');
  });
  // @ts-expect-error override for the test
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
  cleanupTmpDir(tmpDir);
});

describe('zero-network guard (C-23)', () => {
  it('C-23: full connector + worker + semantic flow runs green with fetch armed-to-throw', async () => {
    ingestCcos(db, ccosPath);
    const fake = makeFakeEmbedder();
    await runEmbedWorker(db, { embedder: fake.embedder });
    const hits = await semanticSearch(db, 'matrix warehouse', { embedder: fake.embedder, k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // the guard was never tripped
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

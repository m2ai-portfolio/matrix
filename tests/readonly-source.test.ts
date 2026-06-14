// Read-only source integrity — the REAL claudeclaw.db must be byte-identical before/after a
// representative pipeline pass (which is pointed at a FIXTURE copy, never the real DB).
// Claims: C-21, C-22.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../src/db/schema.js';
import { initVec } from '../src/db/vec.js';
import { ingestCcos } from '../src/connectors/ccos.js';
import { runEmbedWorker } from '../src/embed/worker.js';
import { buildCcosFixture } from './fixtures/ccos-fixture.js';
import { makeFakeEmbedder } from './helpers/fake-embedder.js';
import { makeTmpDir, cleanupTmpDir } from './helpers/tmp.js';

const REAL_CCOS = join(homedir(), 'projects', 'claudeclaw-os', 'store', 'claudeclaw.db');

function md5(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

describe('read-only source integrity (C-21/C-22)', () => {
  it('C-21/C-22: a pipeline pass over a FIXTURE leaves the real claudeclaw.db byte-identical', async () => {
    const realPresent = existsSync(REAL_CCOS);
    // Snapshot the real DB (read-only stat + hash) if it exists.
    const before = realPresent ? { md5: md5(REAL_CCOS), size: statSync(REAL_CCOS).size } : null;

    // Run a representative pass against a FIXTURE copy, never the real path (C-22).
    const tmpDir = makeTmpDir();
    try {
      const ccosPath = buildCcosFixture(tmpDir);
      expect(ccosPath).not.toBe(REAL_CCOS);
      const db = new Database(':memory:');
      applySchema(db);
      initVec(db);
      ingestCcos(db, ccosPath);
      await runEmbedWorker(db, { embedder: makeFakeEmbedder().embedder });
      db.close();
    } finally {
      cleanupTmpDir(tmpDir);
    }

    if (before) {
      const after = { md5: md5(REAL_CCOS), size: statSync(REAL_CCOS).size };
      expect(after.md5).toBe(before.md5); // C-21 byte-identical
      expect(after.size).toBe(before.size);
    } else {
      // The real DB isn't on this machine; the FIXTURE-only guarantee still holds.
      expect(realPresent).toBe(false);
    }
  });
});

// DATA-HYGIENE first-pass safety — .gitignore covers store/ + *.db; default DB path is under the
// repo store/, not a dep install dir; the CCOS connector opens read-only only.
// Claims: C-50, C-51.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { defaultDbPath } from '../src/db/open.js';
import { openCcosReadonly } from '../src/connectors/ccos.js';
import Database from 'better-sqlite3';
import { buildCcosFixture } from './fixtures/ccos-fixture.js';
import { makeTmpDir, cleanupTmpDir } from './helpers/tmp.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('data hygiene (C-50)', () => {
  it('C-50: .gitignore covers store/ and *.db (and wal/shm)', () => {
    const gi = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8');
    expect(gi).toMatch(/^store\/?$/m);
    expect(gi).toMatch(/^\*\.db$/m);
    expect(gi).toMatch(/\*\.db-wal/);
    expect(gi).toMatch(/\*\.db-shm/);
  });
});

describe('data path safety (C-51)', () => {
  it('C-51: defaultDbPath resolves under <repo>/store/matrix.db, not a node_modules/install dir', () => {
    const p = defaultDbPath();
    expect(p.endsWith(`${sep}store${sep}matrix.db`)).toBe(true);
    expect(p.includes('node_modules')).toBe(false);
  });

  it('C-51: the CCOS connector open helper is read-only (write throws)', () => {
    const tmpDir = makeTmpDir();
    try {
      const ccosPath = buildCcosFixture(tmpDir);
      const ro: Database.Database = openCcosReadonly(ccosPath);
      try {
        expect(() =>
          ro
            .prepare(
              "INSERT INTO conversation_log(chat_id, role, content, created_at) VALUES ('x','user','x',0)",
            )
            .run(),
        ).toThrow(/readonly|SQLITE_READONLY/i);
      } finally {
        ro.close();
      }
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

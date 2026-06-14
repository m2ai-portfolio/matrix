// KEYSTONE idempotency test — ingest the fixture TWICE; second pass inserts ZERO new rows.
// Claims: C-09 (keystone), C-12 (INSERT OR IGNORE), C-18 (counts), C-23 (other tables empty).
// Runs against an in-memory better-sqlite3 DB + a temp fixture file. The real store/matrix.db
// and the real ~/.claude/projects transcripts are NEVER touched (C-21/C-22).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { ingestFiles } from '../src/connectors/claude-code.js';
import { FIXTURE_JSONL, EXPECTED_TURN_COUNT } from './fixtures/claude-code-fixture.js';
import { makeTmpDir, writeFixtureFile, cleanupTmpDir } from './helpers/tmp.js';

let tmpDir: string;
let fixtureFile: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = makeTmpDir();
  // The fixture file lives under a project-named dir so `project` derives correctly.
  fixtureFile = writeFixtureFile(tmpDir, 'session-A.jsonl', FIXTURE_JSONL);
  db = new Database(':memory:'); // never the real store (C-21)
  applySchema(db);
});

afterEach(() => {
  db.close();
  cleanupTmpDir(tmpDir);
});

function turnCount(): number {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM conversation_turn').get() as { n: number };
  return n;
}

describe('keystone idempotency (C-09)', () => {
  it('first ingest inserts the deduped turn count; second ingest inserts ZERO new rows', () => {
    const first = ingestFiles(db, [fixtureFile]);
    const countAfterFirst = turnCount();

    // Sanity: the fixture's 4 turn-lines became 4 rows (C-18 counts).
    expect(countAfterFirst).toBe(EXPECTED_TURN_COUNT);
    expect(first.inserted).toBe(EXPECTED_TURN_COUNT);
    expect(first.skipped).toBeGreaterThan(0); // skip lines were counted (C-13/C-16/C-24/C-27/C-28/C-29)

    const second = ingestFiles(db, [fixtureFile]);
    const countAfterSecond = turnCount();

    // THE CONTRACT: row count identical, zero new rows on the second pass.
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.inserted).toBe(0);
  });

  it('C-12: re-ingesting is a no-op via INSERT OR IGNORE on the content-hash PK', () => {
    ingestFiles(db, [fixtureFile]);
    const before = turnCount();
    // Run two more times; still no growth.
    ingestFiles(db, [fixtureFile]);
    ingestFiles(db, [fixtureFile]);
    expect(turnCount()).toBe(before);
  });

  it('C-23: after ingest, embedding/entity/link/outcome remain empty (no Phase-1/2 work)', () => {
    ingestFiles(db, [fixtureFile]);
    for (const t of ['embedding', 'entity', 'link', 'outcome']) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(n).toBe(0);
    }
  });
});

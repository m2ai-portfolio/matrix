// CCOS connector tests — read-only ingest of the 3 tables, content rules, embedding load,
// malformed-data tolerance, idempotency.
// Claims: C-03..C-11, C-20, C-22, C-24, C-25, C-40, C-41, C-42, C-43.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, vecCount, EMBED_MODEL, EMBED_DIM } from '../src/db/vec.js';
import { openCcosReadonly, parseEmbedding, ingestCcos } from '../src/connectors/ccos.js';
import { buildCcosFixture, FIXTURE } from './fixtures/ccos-fixture.js';
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

function turnCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM conversation_turn').get() as { n: number }).n;
}
function embCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM embedding').get() as { n: number }).n;
}
function turnsBySource(src: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM conversation_turn WHERE source = ?').all(src) as Array<
    Record<string, unknown>
  >;
}

describe('parseEmbedding (C-40/C-41/C-42)', () => {
  it('C-40: null/empty returns null', () => {
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding(undefined)).toBeNull();
    expect(parseEmbedding('')).toBeNull();
  });
  it('C-41: malformed JSON returns null (no throw)', () => {
    expect(parseEmbedding('not json')).toBeNull();
    expect(parseEmbedding('{bad')).toBeNull();
  });
  it('C-42: wrong-dim returns null', () => {
    expect(parseEmbedding(JSON.stringify(new Array(768).fill(0.1)))).toBeNull();
  });
  it('valid 3072 JSON parses to a number[] of length 3072', () => {
    const v = parseEmbedding(JSON.stringify(new Array(EMBED_DIM).fill(0.5)));
    expect(Array.isArray(v)).toBe(true);
    expect(v?.length).toBe(EMBED_DIM);
  });
});

describe('openCcosReadonly (C-20)', () => {
  it('C-20: opens read-only; a write attempt throws SQLITE_READONLY', () => {
    const ro = openCcosReadonly(ccosPath);
    try {
      const rows = ro.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      expect(rows.n).toBe(FIXTURE.memories);
      expect(() =>
        ro
          .prepare(
            "INSERT INTO memories(chat_id, raw_text, summary, created_at, accessed_at) VALUES ('x','x','x',0,0)",
          )
          .run(),
      ).toThrow(/readonly|SQLITE_READONLY/i);
    } finally {
      ro.close();
    }
  });
});

describe('ingestCcos (C-03..C-11, C-22, C-24, C-25, C-43)', () => {
  it('C-03/C-05/C-06: ingests all three tables as source=claudeclaw turns', () => {
    const res = ingestCcos(db, ccosPath);
    expect(res.turnsInserted).toBe(FIXTURE.totalTurns);
    expect(turnsBySource('claudeclaw').length).toBe(FIXTURE.totalTurns);
    expect(turnCount()).toBe(FIXTURE.totalTurns);
  });

  it('C-04/C-43: memories content = summary, with empty-summary falling back to raw_text', () => {
    ingestCcos(db, ccosPath);
    const contents = turnsBySource('claudeclaw').map((t) => t.content as string);
    expect(contents).toContain('summary one'); // C-04 normal
    expect(contents).toContain('fallback body'); // C-43 empty summary -> raw_text
    expect(contents).not.toContain('   '); // the empty summary itself never becomes content
  });

  it('C-05: consolidations content = summary + insight', () => {
    ingestCcos(db, ccosPath);
    const contents = turnsBySource('claudeclaw').map((t) => t.content as string);
    const consTurn = contents.find((c) => c.includes('cons summary') && c.includes('cons insight'));
    expect(consTurn).toBeTruthy();
  });

  it('C-06: conversation_log carries role', () => {
    ingestCcos(db, ccosPath);
    const roles = turnsBySource('claudeclaw').map((t) => t.role as string);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('C-07: project/meta carries the CCOS table name + source row id', () => {
    ingestCcos(db, ccosPath);
    const rows = turnsBySource('claudeclaw');
    // every turn names which CCOS table it came from, in project or meta
    for (const r of rows) {
      const blob = `${r.project as string} ${r.meta as string}`;
      expect(/memories|consolidations|conversation_log/.test(blob)).toBe(true);
      // meta should carry the source row id
      const meta = JSON.parse(r.meta as string) as Record<string, unknown>;
      expect(meta).toHaveProperty('ccos_table');
      expect(meta).toHaveProperty('ccos_id');
    }
  });

  it('C-08: turn_id is a deterministic content hash (64-hex)', () => {
    ingestCcos(db, ccosPath);
    for (const r of turnsBySource('claudeclaw')) {
      expect(/^[0-9a-f]{64}$/.test(r.turn_id as string)).toBe(true);
    }
  });

  it('C-09/C-10/C-11: pre-existing 3072 embeddings load into embedding table + vec index with model/dim', () => {
    const res = ingestCcos(db, ccosPath);
    expect(res.embeddingsLoaded).toBe(FIXTURE.validEmbeddings);
    expect(embCount()).toBe(FIXTURE.validEmbeddings); // C-09
    expect(vecCount(db)).toBe(FIXTURE.validEmbeddings); // C-10

    const embRows = db.prepare('SELECT model, dim FROM embedding').all() as Array<{
      model: string;
      dim: number;
    }>;
    for (const e of embRows) {
      expect(e.model).toBe(EMBED_MODEL); // C-11
      expect(e.dim).toBe(EMBED_DIM); // C-11
    }
  });

  it('C-40/C-41/C-42: null/malformed/wrong-dim embeddings load 0 embeddings but still ingest the turn (no crash)', () => {
    // Only m1 + cons1 are valid; m2(null), m3(malformed), m4(wrong-dim), m5(null) must not load.
    const res = ingestCcos(db, ccosPath);
    expect(res.turnsInserted).toBe(FIXTURE.totalTurns); // all turns ingest
    expect(res.embeddingsLoaded).toBe(FIXTURE.validEmbeddings); // only valid ones load
  });

  it('C-24/C-25: a second run inserts 0 new turns and 0 new embeddings (idempotent)', () => {
    ingestCcos(db, ccosPath);
    const turnsAfter1 = turnCount();
    const embAfter1 = embCount();
    const vecAfter1 = vecCount(db);

    const second = ingestCcos(db, ccosPath);
    expect(second.turnsInserted).toBe(0); // C-24
    expect(second.embeddingsLoaded).toBe(0); // C-25
    expect(turnCount()).toBe(turnsAfter1);
    expect(embCount()).toBe(embAfter1);
    expect(vecCount(db)).toBe(vecAfter1);
  });
});

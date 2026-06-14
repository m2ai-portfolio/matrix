// Schema tests — canonical conversation_turn columns + empty tables + idempotent apply.
// Claims: C-03, C-04, C-05, C-06, C-07, C-10, C-23.
// Uses an in-memory better-sqlite3 DB; the real store/matrix.db is never written.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';

/** Open a throwaway in-memory DB with the schema applied. */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

interface ColumnRow {
  name: string;
  type: string;
  pk: number;
}

function columns(db: Database.Database, table: string): ColumnRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
}

describe('schema', () => {
  it('C-03: conversation_turn has EXACTLY the §4 columns with correct PK', () => {
    const db = freshDb();
    const cols = columns(db, 'conversation_turn');
    const names = cols.map((c) => c.name);
    // Exactly these, in any order, but no more and no fewer.
    expect(new Set(names)).toEqual(
      new Set([
        'turn_id',
        'source',
        'source_id',
        'ingestion_batch_id',
        'conversation_id',
        'ts',
        'role',
        'content',
        'tokens',
        'project',
        'meta',
      ]),
    );
    expect(names).toHaveLength(11);
    // turn_id is the PRIMARY KEY (C-03).
    const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(['turn_id']);
  });

  it('C-04: embedding(turn_id, model, dim, vector) table exists', () => {
    const db = freshDb();
    const names = columns(db, 'embedding').map((c) => c.name);
    expect(new Set(names)).toEqual(new Set(['turn_id', 'model', 'dim', 'vector']));
  });

  it('C-05: entity(turn_id, kind, value) table exists', () => {
    const db = freshDb();
    const names = columns(db, 'entity').map((c) => c.name);
    expect(new Set(names)).toEqual(new Set(['turn_id', 'kind', 'value']));
  });

  it('C-06: link(src_turn_id, dst_turn_id, kind, weight) table exists', () => {
    const db = freshDb();
    const names = columns(db, 'link').map((c) => c.name);
    expect(new Set(names)).toEqual(new Set(['src_turn_id', 'dst_turn_id', 'kind', 'weight']));
  });

  it('C-07: outcome(turn_id, fed_work, artifact_ref) table exists', () => {
    const db = freshDb();
    const names = columns(db, 'outcome').map((c) => c.name);
    expect(new Set(names)).toEqual(new Set(['turn_id', 'fed_work', 'artifact_ref']));
  });

  it('C-10: applySchema is idempotent (callable repeatedly, no throw)', () => {
    const db = new Database(':memory:');
    expect(() => {
      applySchema(db);
      applySchema(db);
      applySchema(db);
    }).not.toThrow();
  });

  it('C-23: embedding/entity/link/outcome are created EMPTY (zero rows)', () => {
    const db = freshDb();
    for (const t of ['embedding', 'entity', 'link', 'outcome']) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(n).toBe(0);
    }
  });
});

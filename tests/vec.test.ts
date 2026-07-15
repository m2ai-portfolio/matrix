// vec0 index tests — load, create at dim 3072, KNN, dim guard.
// Claims: C-01, C-02, C-19, C-32, C-42.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import {
  EMBED_MODEL,
  EMBED_DIM,
  initVec,
  loadVec,
  upsertVec,
  vecCount,
  hasVec,
  knn,
  toFloat32,
} from '../src/db/vec.js';
import { fixtureVec } from './fixtures/ccos-fixture.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  initVec(db);
});

afterEach(() => {
  db.close();
});

describe('vec module (C-01/C-02/C-19/C-32/C-42)', () => {
  it('C-19: canonical model + dim constants are Qwen/Qwen3-Embedding-8B / 4096', () => {
    // Ground-truth pin: updated 2026-07-12 with the DeepInfra migration (was gemini-embedding-001/3072).
    // If this fails, a model change happened without consciously updating the pin. That is the bug.
    expect(EMBED_MODEL).toBe('Qwen/Qwen3-Embedding-8B');
    expect(EMBED_DIM).toBe(4096);
  });

  it('C-32: the sqlite-vec extension loads (vec_version available)', () => {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    expect(typeof row.v).toBe('string');
    expect(row.v.length).toBeGreaterThan(0);
  });

  it('C-01/C-02: insert a known 3072 vector, KNN returns it as the nearest (distance ~0)', () => {
    const target = fixtureVec(42);
    const other = fixtureVec(999);
    upsertVec(db, 'turn-target', target);
    upsertVec(db, 'turn-other', other);
    expect(vecCount(db)).toBe(2);
    expect(hasVec(db, 'turn-target')).toBe(true);

    const hits = knn(db, target, 2);
    expect(hits.length).toBe(2);
    expect(hits[0].turn_id).toBe('turn-target');
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
    expect(hits[0].distance).toBeLessThan(1e-3);
  });

  it('C-42: toFloat32 throws on a vector whose length != 3072 (dim guard)', () => {
    expect(() => toFloat32(new Array(768).fill(0.1))).toThrow();
    expect(() => toFloat32(fixtureVec(1))).not.toThrow();
  });

  it('upsertVec is idempotent per turn_id (no duplicate vec rows on re-upsert)', () => {
    const v = fixtureVec(7);
    upsertVec(db, 'turn-x', v);
    upsertVec(db, 'turn-x', v);
    expect(vecCount(db)).toBe(1);
  });

  it('loadVec is safe to call directly (idempotent extension load)', () => {
    expect(() => loadVec(db)).not.toThrow();
  });
});

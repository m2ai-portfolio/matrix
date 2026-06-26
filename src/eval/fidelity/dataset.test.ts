// Tests for the fidelity-eval dataset loader. Hermetic: a temp warehouse seeded with
// soundwave rows + Float32 embedding BLOBs, never the live store.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../db/open.js';
import { decodeVector, loadSoundwaveGrades } from './dataset.js';

function blobOf(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function tempDb() {
  const path = join(tmpdir(), `matrix-fid-ds-${process.pid}-${Math.floor(performance.now())}.db`);
  return openDb(path);
}

describe('decodeVector', () => {
  it('round-trips a Float32 BLOB', () => {
    const v = decodeVector(blobOf([1.5, -2.25, 0, 3]));
    expect(Array.from(v)).toEqual([1.5, -2.25, 0, 3]);
  });
  it('rejects a non-multiple-of-4 length', () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]))).toThrow();
  });
});

describe('loadSoundwaveGrades', () => {
  it('loads only embedded soundwave rows with a valid verdict', () => {
    const db = tempDb();
    const insT = db.prepare(
      'INSERT INTO conversation_turn (turn_id, source, role, content, meta) VALUES (?, ?, ?, ?, ?)',
    );
    const insE = db.prepare(
      'INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)',
    );

    // good up
    insT.run(
      'a',
      'soundwave',
      'article',
      'art A',
      JSON.stringify({ verdict: 'up', notes: 'useful', domain: 'x.com', url: 'u1' }),
    );
    insE.run('a', 'gemini-embedding-001', 4, blobOf([1, 0, 0, 0]));
    // good down
    insT.run(
      'b',
      'soundwave',
      'article',
      'art B',
      JSON.stringify({ verdict: 'down', notes: 'off-stack', domain: 'y.com', url: 'u2' }),
    );
    insE.run('b', 'gemini-embedding-001', 4, blobOf([0, 1, 0, 0]));
    // soundwave but NO embedding -> skipped
    insT.run(
      'c',
      'soundwave',
      'article',
      'art C',
      JSON.stringify({ verdict: 'up', domain: 'z.com' }),
    );
    // soundwave, embedded, but no verdict -> skipped
    insT.run('d', 'soundwave', 'article', 'art D', JSON.stringify({ domain: 'z.com' }));
    insE.run('d', 'gemini-embedding-001', 4, blobOf([0, 0, 1, 0]));
    // different source -> skipped
    insT.run('e', 'claude_code', 'user', 'hi', JSON.stringify({ verdict: 'up' }));
    insE.run('e', 'gemini-embedding-001', 4, blobOf([0, 0, 0, 1]));

    const grades = loadSoundwaveGrades(db);
    db.close();

    expect(grades.map((g) => g.turnId).sort()).toEqual(['a', 'b']);
    const a = grades.find((g) => g.turnId === 'a')!;
    expect(a.verdict).toBe('up');
    expect(a.notes).toBe('useful');
    expect(a.domain).toBe('x.com');
    expect(Array.from(a.vector)).toEqual([1, 0, 0, 0]);
  });
});

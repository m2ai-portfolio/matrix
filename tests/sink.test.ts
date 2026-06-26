// Tests for the WarehouseSink — the Phase-2 LOAD seam.
//
// Hermetic: an in-memory DB with the real schema. The sink is exercised directly with built
// NormalizedTurns so the INSERT-OR-IGNORE dedup, the per-turn error collection (never throws),
// and the borrowed-handle contract are all covered. ZERO network, ZERO live store access.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { gradeToTurn, type Grade, type SeenEntry } from '../src/connectors/soundwave.js';
import { WarehouseSink } from '../src/connectors/sink.js';

const grade: Grade = {
  id: 'venturebeat-376e2b67',
  title: 'Krea 2 Raw and Turbo available as open weights',
  tag: 'discovered',
  verdict: 'down',
  notes: 'Not actionable - outside of our stack',
  ts: '2026-06-23T22:33:39.292981Z',
  batch: '2026-06-23',
  source: 'venturebeat.com',
};
const seen: SeenEntry = { url: 'https://venturebeat.com/krea-2', title: grade.title };

describe('WarehouseSink', () => {
  it('has a stable name', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(new WarehouseSink(db).name).toBe('warehouse');
    db.close();
  });

  it('inserts new turns and skips duplicate turn_ids (INSERT OR IGNORE)', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const sink = new WarehouseSink(db);
    const turn = gradeToTurn(grade, seen);

    const first = sink.write([turn]);
    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);
    expect(first.errors).toEqual([]);

    // Same turn_id again -> deduped, not a second row.
    const second = sink.write([turn]);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM conversation_turn WHERE source='soundwave'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    db.close();
  });

  it('writes a mixed batch: a fresh turn inserts, an already-present turn skips', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const sink = new WarehouseSink(db);
    const a = gradeToTurn(grade, seen);
    const b = gradeToTurn({ ...grade, id: 'github-aaaa1111', source: 'github.com' }, seen);

    sink.write([a]); // a already present
    const r = sink.write([a, b]); // a -> skip, b -> insert
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors).toEqual([]);
    db.close();
  });

  it('collects a per-turn write failure instead of throwing the whole batch', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.close(); // closing makes the next prepare/run throw — simulates a write failure
    const sink = new WarehouseSink(db);
    const r = sink.write([gradeToTurn(grade, seen)]);
    expect(r.inserted).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain(gradeToTurn(grade, seen).turn_id);
  });

  it('an empty batch is a clean no-op', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const r = new WarehouseSink(db).write([]);
    expect(r).toEqual({ inserted: 0, skipped: 0, errors: [] });
    db.close();
  });
});

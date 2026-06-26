// Tests for the decision/outcome ETL core (transform + load). Hermetic: :memory: warehouse only.

import { describe, it, expect } from 'vitest';
import { openDb } from '../db/open.js';
import {
  decisionToTurn,
  insertOutcome,
  loadDecisions,
  decisionContent,
  type DecisionTriple,
} from './decision.js';

function triple(over: Partial<DecisionTriple> = {}): DecisionTriple {
  return {
    situation: 'DaaS vs CCaaS',
    choice: 'Build DaaS first',
    rationale: 'wins 5 of 6 lenses',
    sourceKind: 'vault_decision',
    sourcePath: '/v/decisions/x.md',
    anchor: 'decision-memo',
    ts: '2026-06-24',
    ...over,
  };
}

describe('decisionToTurn', () => {
  it('maps Option A: role/source decision, full triple in content, kind in meta', () => {
    const turn = decisionToTurn(triple(), 'batch-1');
    expect(turn.source).toBe('decision');
    expect(turn.role).toBe('decision');
    expect(turn.content).toBe(decisionContent(triple()));
    expect(turn.ingestion_batch_id).toBe('batch-1');
    expect(JSON.parse(turn.meta)).toMatchObject({
      sourceKind: 'vault_decision',
      choice: 'Build DaaS first',
    });
  });

  it('identity is situation+choice only: rationale edits do NOT change turn_id', () => {
    const a = decisionToTurn(triple({ rationale: 'first wording' }), null);
    const b = decisionToTurn(triple({ rationale: 'totally rewritten rationale' }), null);
    expect(a.turn_id).toBe(b.turn_id);
  });

  it('a different choice DOES change turn_id', () => {
    const a = decisionToTurn(triple({ choice: 'Build DaaS first' }), null);
    const b = decisionToTurn(triple({ choice: 'Build CCaaS first' }), null);
    expect(a.turn_id).not.toBe(b.turn_id);
  });
});

describe('insertOutcome', () => {
  it('writes once and is idempotent on re-insert for the same turn_id', () => {
    const db = openDb(':memory:');
    expect(insertOutcome(db, 't1', true, 'ref')).toBe(true);
    expect(insertOutcome(db, 't1', true, 'ref')).toBe(false); // skipped
    const rows = db.prepare('SELECT fed_work, artifact_ref FROM outcome WHERE turn_id=?').all('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fed_work: 1, artifact_ref: 'ref' });
    db.close();
  });
});

describe('loadDecisions', () => {
  it('writes turns via WarehouseSink + outcome rows only for triples that carry one', () => {
    const db = openDb(':memory:');
    const triples = [
      triple({ choice: 'A', outcome: { fedWork: true, artifactRef: 'proj-a' } }),
      triple({ choice: 'B' }), // no outcome
    ];
    const r = loadDecisions(db, triples, 'b');
    expect(r.turnsInserted).toBe(2);
    expect(r.outcomesInserted).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM conversation_turn WHERE source='decision'").get(),
    ).toMatchObject({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcome').get()).toMatchObject({ n: 1 });
    db.close();
  });

  it('is idempotent: a second identical load inserts nothing new', () => {
    const db = openDb(':memory:');
    const triples = [triple({ outcome: { fedWork: false, artifactRef: 'r' } })];
    loadDecisions(db, triples, 'b');
    const r2 = loadDecisions(db, triples, 'b');
    expect(r2.turnsInserted).toBe(0);
    expect(r2.turnsSkipped).toBe(1);
    expect(r2.outcomesInserted).toBe(0);
    expect(r2.outcomesSkipped).toBe(1);
    db.close();
  });
});

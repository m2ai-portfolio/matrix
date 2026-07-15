// Tests for the AUQ forced-choice dataset: extraction (pure), the leak guard, and the warehouse
// write/load round-trip. Hermetic: synthetic transcript records + a temp warehouse, never the live store.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../db/open.js';
import {
  extractAuqTriples,
  writeAuqTurns,
  loadAuqTriples,
  AUQ_SITUATION_MODEL,
  type AuqTriple,
} from './auq-dataset.js';

function blobOf(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function tempDb() {
  const path = join(tmpdir(), `matrix-auq-ds-${process.pid}-${Math.floor(performance.now())}.db`);
  return openDb(path);
}

/** Build a transcript-shaped tool_use record for an AskUserQuestion call. */
function useRecord(id: string, questions: unknown[]) {
  return {
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id, input: { questions } }] },
  };
}

/** Build a transcript-shaped tool_result record. */
function resultRecord(toolUseId: string, text: string) {
  return {
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  };
}

function q(question: string, labels: string[], header = '', multiSelect = false) {
  return { question, header, multiSelect, options: labels.map((label) => ({ label })) };
}

describe('extractAuqTriples', () => {
  it('keeps a clean label pick and excludes a free-text "Other" answer', () => {
    const records = [
      useRecord('t1', [q('Pick a store?', ['SQLite', 'Postgres'])]),
      resultRecord('t1', 'Your questions have been answered: "Pick a store?"="SQLite". Continue.'),
      // free-text answer that matches no label -> excluded
      useRecord('t2', [q('Which color?', ['Red', 'Blue'])]),
      resultRecord(
        't2',
        'Your questions have been answered: "Which color?"="something custom". Continue.',
      ),
    ];
    const { triples } = extractAuqTriples(records);
    expect(triples.map((t) => t.id)).toEqual(['auq:t1:0']);
    const t = triples[0];
    expect(t.chosen).toBe('SQLite');
    expect(t.chosenIdx).toBe(0);
    expect(t.rejected).toEqual(['Postgres']);
    expect(t.situation).toBe('Pick a store?');
  });

  it('detects the (recommended) marker and sets recommendedIdx', () => {
    const records = [
      useRecord('r1', [q('Deploy where?', ['Render (Recommended)', 'Railway'])]),
      resultRecord('r1', 'Your questions have been answered: "Deploy where?"="Railway". Continue.'),
    ];
    const { triples } = extractAuqTriples(records);
    expect(triples).toHaveLength(1);
    expect(triples[0].recommendedIdx).toBe(0);
    expect(triples[0].chosenIdx).toBe(1); // the owner deviated from the recommendation
  });

  it('drops a triple whose situation contains an option label (leak by construction)', () => {
    const records = [
      // the question text literally contains the label "Postgres" -> would leak -> dropped
      useRecord('l1', [q('Should I use Postgres or SQLite?', ['Postgres', 'SQLite'])]),
      resultRecord(
        'l1',
        'Your questions have been answered: "Should I use Postgres or SQLite?"="SQLite". Continue.',
      ),
    ];
    const { triples, leakDropped } = extractAuqTriples(records);
    expect(triples).toHaveLength(0);
    expect(leakDropped).toBe(1);
  });

  it('handles a multi-question call, prefixing the header into the situation', () => {
    const records = [
      useRecord('m1', [
        q('First choice?', ['A', 'B'], 'Topic1'),
        q('Second choice?', ['C', 'D'], 'Topic2'),
      ]),
      resultRecord(
        'm1',
        'Your questions have been answered: "First choice?"="A", "Second choice?"="D". Continue.',
      ),
    ];
    const { triples } = extractAuqTriples(records);
    expect(triples.map((t) => t.id)).toEqual(['auq:m1:0', 'auq:m1:1']);
    expect(triples[0].situation).toBe('Topic1\nFirst choice?');
    expect(triples[0].chosen).toBe('A');
    expect(triples[1].chosen).toBe('D');
  });

  it('ignores an unanswered AUQ call (no matching tool_result)', () => {
    const records = [useRecord('u1', [q('Pick?', ['A', 'B'])])];
    const { triples } = extractAuqTriples(records);
    expect(triples).toHaveLength(0);
  });
});

describe('leak guard (invariant)', () => {
  it('no returned triple situation contains any of its option labels', () => {
    const records = [
      useRecord('g1', [
        q('Which database engine fits a local-first warehouse?', ['SQLite', 'DuckDB']),
      ]),
      resultRecord(
        'g1',
        'Your questions have been answered: "Which database engine fits a local-first warehouse?"="SQLite". Continue.',
      ),
      useRecord('g2', [q('How should ingestion run?', ['File queue', 'Direct API'])]),
      resultRecord(
        'g2',
        'Your questions have been answered: "How should ingestion run?"="File queue". Continue.',
      ),
    ];
    const { triples } = extractAuqTriples(records);
    expect(triples.length).toBeGreaterThan(0);
    const lower = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const t of triples) {
      const sit = lower(t.situation);
      for (const label of t.options) {
        expect(sit.includes(lower(label))).toBe(false);
      }
    }
  });
});

describe('writeAuqTurns + loadAuqTriples round-trip', () => {
  it('persists triples and re-loads them joined to their situation embedding', () => {
    const db = tempDb();
    const triples: AuqTriple[] = [
      {
        id: 'auq:x:0',
        situation: 'Pick a store?',
        header: '',
        options: ['SQLite', 'Postgres'],
        chosen: 'SQLite',
        chosenIdx: 0,
        rejected: ['Postgres'],
        recommendedIdx: 0,
        multiSelect: false,
      },
    ];
    const written = writeAuqTurns(db, triples);
    expect(written).toBe(1);

    // No embedding yet -> the loader (which requires a vector) returns nothing.
    expect(loadAuqTriples(db)).toHaveLength(0);

    // Insert the situation embedding under the distinct key, then it loads.
    db.prepare('INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)').run(
      'auq:x:0',
      AUQ_SITUATION_MODEL,
      4,
      blobOf([1, 0, 0, 0]),
    );
    const loaded = loadAuqTriples(db);
    db.close();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].chosen).toBe('SQLite');
    expect(loaded[0].recommendedIdx).toBe(0);
    expect(Array.from(loaded[0].vector!)).toEqual([1, 0, 0, 0]);
  });

  it('is idempotent: re-writing the same triple does not duplicate rows', () => {
    const db = tempDb();
    const triples: AuqTriple[] = [
      {
        id: 'auq:y:0',
        situation: 'Choose?',
        header: '',
        options: ['A', 'B'],
        chosen: 'B',
        chosenIdx: 1,
        rejected: ['A'],
        recommendedIdx: null,
        multiSelect: false,
      },
    ];
    writeAuqTurns(db, triples);
    writeAuqTurns(db, triples);
    const count = db
      .prepare("SELECT count(*) AS c FROM conversation_turn WHERE source='auq'")
      .get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });
});

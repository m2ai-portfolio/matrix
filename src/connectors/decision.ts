// Matrix Phase 4: decision/outcome ETL core (transform + load).
// See ./decision-etl-design.md. Harvests decision triples (situation, choice, rationale [, outcome])
// and loads them into the warehouse as role='decision' conversation_turns via the Phase-2
// WarehouseSink, writing the labeled judgment into the outcome table when present.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import { turnId, type NormalizedTurn } from './claude-code.js';
import { WarehouseSink } from './sink.js';

/** Where a decision came from. One lane (source='decision'); the kind is kept in meta. */
export type DecisionSourceKind = 'vault_decision' | 'daily_tldr' | 'active_work_card' | 'goal_card';

/** A labeled terminal verdict, present only when the source carries one. */
export interface DecisionOutcome {
  /** Did the decision lead to acted-on work? done/decided => true, blocked => false. */
  fedWork: boolean;
  /** Pointer to the artifact/sink/result, for traceability. */
  artifactRef: string;
}

/** A harvested decision. `situation`+`choice` form the stable identity; `rationale` is volatile. */
export interface DecisionTriple {
  situation: string;
  choice: string;
  rationale: string;
  outcome?: DecisionOutcome;
  sourceKind: DecisionSourceKind;
  sourcePath: string;
  anchor: string;
  ts: string;
  project?: string;
}

/** Build the stored content body from a triple (full triple, including rationale). */
export function decisionContent(t: DecisionTriple): string {
  return `Situation: ${t.situation}\n\nChoice: ${t.choice}\n\nRationale: ${t.rationale}`;
}

/**
 * Pure transform: DecisionTriple -> NormalizedTurn (Option A mapping). The turn_id is hashed over
 * situation+choice ONLY (not the volatile rationale), so a re-run after a rationale edit does not
 * create a duplicate row. role='decision', source='decision'; the sourceKind lives in meta.
 */
export function decisionToTurn(t: DecisionTriple, batchId: string | null): NormalizedTurn {
  const source = 'decision';
  const source_id = `${t.sourceKind}:${t.sourcePath}#${t.anchor}`;
  const conversation_id = t.sourcePath;
  const role = 'decision';
  const id = turnId({
    source,
    source_id,
    conversation_id,
    role,
    content: `${t.situation}\n${t.choice}`, // identity = situation + choice
  });
  return {
    turn_id: id,
    source,
    source_id,
    ingestion_batch_id: batchId,
    conversation_id,
    ts: t.ts,
    role,
    content: decisionContent(t),
    tokens: null,
    project: t.project ?? '',
    meta: JSON.stringify({
      sourceKind: t.sourceKind,
      sourcePath: t.sourcePath,
      anchor: t.anchor,
      choice: t.choice,
      hasOutcome: t.outcome !== undefined,
    }),
  };
}

/**
 * Idempotently write one outcome row. The outcome table has no PK, so guard on an existing row for
 * this turn_id (skip if present) to keep re-runs idempotent. Returns true if a row was inserted.
 */
export function insertOutcome(
  db: Database,
  turn_id: string,
  fedWork: boolean,
  artifactRef: string,
): boolean {
  const existing = db.prepare('SELECT 1 AS x FROM outcome WHERE turn_id = ?').get(turn_id);
  if (existing) return false;
  db.prepare('INSERT INTO outcome (turn_id, fed_work, artifact_ref) VALUES (?, ?, ?)').run(
    turn_id,
    fedWork ? 1 : 0,
    artifactRef,
  );
  return true;
}

export interface DecisionLoadReport {
  turnsInserted: number;
  turnsSkipped: number;
  turnErrors: string[];
  outcomesInserted: number;
  outcomesSkipped: number;
}

/**
 * Load decision triples: write the turns through the Phase-2 WarehouseSink (INSERT OR IGNORE,
 * dedup by turn_id), then write a labeled outcome row for each triple that carries one. The Sink
 * handle is borrowed; the caller owns open/close.
 */
export function loadDecisions(
  db: Database,
  triples: DecisionTriple[],
  batchId: string | null,
): DecisionLoadReport {
  const pairs = triples.map((t) => ({ t, turn: decisionToTurn(t, batchId) }));
  const sink = new WarehouseSink(db);
  const turnReport = sink.write(pairs.map((p) => p.turn));

  let outcomesInserted = 0;
  let outcomesSkipped = 0;
  for (const { t, turn } of pairs) {
    if (!t.outcome) continue;
    if (insertOutcome(db, turn.turn_id, t.outcome.fedWork, t.outcome.artifactRef))
      outcomesInserted++;
    else outcomesSkipped++;
  }

  return {
    turnsInserted: turnReport.inserted,
    turnsSkipped: turnReport.skipped,
    turnErrors: turnReport.errors,
    outcomesInserted,
    outcomesSkipped,
  };
}

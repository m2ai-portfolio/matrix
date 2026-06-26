/**
 * sink.ts — the minimal warehouse-write seam (Phase 2 of the Soundwave->Matrix ETL roadmap).
 *
 * WHY: Phase 1 (soundwave.ts) wrote turns to the warehouse with an inline insertTurn loop. ETL #2
 * (Phase 4) will reuse the SAME write contract, so the LOAD step is extracted behind a tiny Sink
 * interface now: one method — write a batch of NormalizedTurns, report inserted/skipped/errors.
 * This is the "make LOAD an interface" seam from the ETL roadmap, kept deliberately minimal.
 *
 * SCOPE (Phase 2): exactly one interface (Sink) and one implementation (WarehouseSink, the
 * INSERT-OR-IGNORE writer over the live conversation_turn table). A second implementation
 * (e.g. HtmlDigestSink) and any polymorphic Sources/Transforms/PipelineConfig are DEFERRED to
 * Phase 4, when ETL #2 actually needs them (see soundwave-matrix-phase2-note.md). No premature
 * abstraction: this is the transport seam the Matrix CLAUDE.md calls "IngestSink", reduced to the
 * one shape Phase 1 already needs.
 *
 * NOTE: distinct from src/mine/sink.ts, which sinks Mine findings to daily notes + the outcome
 * table — a different destination, and a pre-existing function-style sink.
 */
import type Database from 'better-sqlite3';
import { insertTurn, type NormalizedTurn } from './claude-code.js';

/** What a single Sink.write produced. */
export interface SinkWriteReport {
  inserted: number; // rows newly written (INSERT OR IGNORE reported a change)
  skipped: number; // turns whose turn_id already existed (deduped)
  errors: string[]; // per-turn write failures, formatted "<turn_id>: <message>"
}

/**
 * A destination for normalized turns: the minimal LOAD contract every ETL lane writes through.
 * write() must not throw for a single bad row — a per-turn failure is collected into errors so a
 * batch is never aborted halfway (one poisoned turn cannot lose the rest of the run).
 */
export interface Sink {
  /** Stable name for logging which sink ran. */
  readonly name: string;
  write(turns: NormalizedTurn[]): SinkWriteReport;
}

/**
 * The warehouse conversation_turn sink: INSERT OR IGNORE each turn via the shared insertTurn,
 * exactly as the Phase-1 inline loop did. Dedup is by turn_id (insertTurn returns false on a
 * duplicate). Holds a BORROWED Database handle — it neither opens nor closes the connection; the
 * caller owns that lifecycle (matching ingestLive's openDb()/close() ownership).
 */
export class WarehouseSink implements Sink {
  readonly name = 'warehouse';

  constructor(private readonly db: Database.Database) {}

  write(turns: NormalizedTurn[]): SinkWriteReport {
    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const turn of turns) {
      try {
        if (insertTurn(this.db, turn)) inserted += 1;
        else skipped += 1;
      } catch (e) {
        errors.push(`${turn.turn_id}: ${(e as Error).message}`);
      }
    }
    return { inserted, skipped, errors };
  }
}

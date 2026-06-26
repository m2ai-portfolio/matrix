// Matrix Phase 4: decision/outcome ETL run entrypoint (dry-run + gated live ingest).
// See ./decision-etl-design.md. Dry-run uses an in-memory DB (zero live writes) and reports
// per-source triple counts + samples; the gated live ingest writes role='decision' turns + outcome
// rows into the live store/matrix.db, INSERT OR IGNORE, outside the matrix cron window.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '../db/open.js';
import { inCronWindow } from './soundwave.js';
import { loadDecisions, type DecisionLoadReport, type DecisionTriple } from './decision.js';
import {
  extractVaultDecisions,
  extractDailyDecisions,
  extractActiveWorkCards,
  extractGoalCards,
} from './decision-extractors.js';

/** A wired decision source: a kind, its on-disk root, and the extractor that parses it. */
export interface DecisionSource {
  kind: string;
  dir: string;
  extract: (dir: string) => DecisionTriple[];
}

/** The wired sources. Built one-end-to-end-then-scale: decisions/ first; others added next. */
export function defaultSources(notes = join(homedir(), 'notes')): DecisionSource[] {
  return [
    { kind: 'vault_decision', dir: join(notes, 'decisions'), extract: extractVaultDecisions },
    { kind: 'daily_tldr', dir: join(notes, 'daily'), extract: extractDailyDecisions },
    {
      kind: 'active_work_card',
      dir: join(notes, 'active-work', 'cards'),
      extract: extractActiveWorkCards,
    },
    { kind: 'goal_card', dir: join(notes, 'afk-tasks'), extract: extractGoalCards },
  ];
}

export interface PerSourceReport {
  kind: string;
  dir: string;
  triples: number;
  /** First few situations, for a human to eyeball the extraction. */
  samples: string[];
  /** True when a wired source produced 0 triples (kill-gate signal). */
  degenerate: boolean;
}

export interface DecisionDryRunReport {
  perSource: PerSourceReport[];
  totalTriples: number;
  load: DecisionLoadReport;
  /** decision turns present with no embedding row (what embed-batch would pick up). */
  embedQueueDelta: number;
  /** Wired sources that yielded 0 triples (HALT-worthy). */
  degenerateSources: string[];
}

/** Extract every wired source and return the flat triple list plus per-source counts. */
function extractAll(sources: DecisionSource[]): {
  triples: DecisionTriple[];
  perSource: PerSourceReport[];
} {
  const perSource: PerSourceReport[] = [];
  const triples: DecisionTriple[] = [];
  for (const s of sources) {
    const got = s.extract(s.dir);
    triples.push(...got);
    perSource.push({
      kind: s.kind,
      dir: s.dir,
      triples: got.length,
      samples: got.slice(0, 3).map((t) => t.situation),
      degenerate: got.length === 0,
    });
  }
  return { triples, perSource };
}

function countEmbedQueueDelta(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM conversation_turn t
         LEFT JOIN embedding e ON e.turn_id = t.turn_id
        WHERE t.source = 'decision' AND e.turn_id IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Dry-run: extract every wired source, load into a throwaway :memory: warehouse, and report counts
 * + samples. Zero writes to the live store. A wired source yielding 0 triples is flagged degenerate.
 */
export function dryRun(sources: DecisionSource[] = defaultSources()): DecisionDryRunReport {
  const { triples, perSource } = extractAll(sources);
  const db = openDb(':memory:');
  try {
    const load = loadDecisions(db, triples, 'dryrun');
    const embedQueueDelta = countEmbedQueueDelta(db);
    return {
      perSource,
      totalTriples: triples.length,
      load,
      embedQueueDelta,
      degenerateSources: perSource.filter((p) => p.degenerate).map((p) => p.kind),
    };
  } finally {
    db.close();
  }
}

export interface LiveIngestDeps {
  now?: Date;
  /** Bypass the cron-window guard for an explicit off-window manual run. */
  force?: boolean;
  /** Injectable handle (tests). Default opens the live store/matrix.db. */
  db?: Database.Database;
  sources?: DecisionSource[];
  batchId?: string;
}

export interface LiveIngestReport {
  halted: boolean;
  reason?: string;
  totalTriples: number;
  load?: DecisionLoadReport;
  embedQueueDelta?: number;
}

/**
 * Gated live ingest: refuse to run inside the matrix cron window (05:00-07:00 CT) unless forced,
 * then write role='decision' turns + outcome rows into the live warehouse (INSERT OR IGNORE).
 * The new turns land WITHOUT embeddings; scripts/embed-batch.ts embeds them in a separate gated step.
 */
export function ingestLive(deps: LiveIngestDeps = {}): LiveIngestReport {
  const now = deps.now ?? new Date();
  if (!deps.force && inCronWindow(now)) {
    return {
      halted: true,
      reason: 'inside matrix cron window 05:00-07:00 CT; rerun outside the window or pass force',
      totalTriples: 0,
    };
  }
  const sources = deps.sources ?? defaultSources();
  const { triples } = extractAll(sources);
  if (triples.length === 0) {
    return {
      halted: true,
      reason: '[HALT] no parseable decision triples from any wired source',
      totalTriples: 0,
    };
  }

  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openDb();
  try {
    const batchId = deps.batchId ?? `decision-${now.toISOString()}`;
    const load = loadDecisions(db, triples, batchId);
    const embedQueueDelta = countEmbedQueueDelta(db);
    return { halted: false, totalTriples: triples.length, load, embedQueueDelta };
  } finally {
    if (ownsDb) db.close();
  }
}

// --- report rendering + CLI ----------------------------------------------------------

export function renderDryRunReport(r: DecisionDryRunReport, generatedAt: string): string {
  const lines = [
    '# Decision/outcome ETL: Phase 4 dry-run report',
    '',
    `Generated: ${generatedAt}`,
    'Mode: :memory: dry-run (ZERO live writes). Connector: `src/connectors/decision.ts`.',
    '',
    '## Per-source triples',
    '',
    '| source | dir | triples | sample situations |',
    '|---|---|---|---|',
    ...r.perSource.map(
      (p) =>
        `| ${p.kind} | ${p.dir.replace(homedir(), '~')} | ${p.triples} | ${p.samples.map((s) => s.slice(0, 60)).join(' / ') || '(none)'} |`,
    ),
    '',
    '## Load (into throwaway :memory: warehouse)',
    '',
    `- total triples: ${r.totalTriples}`,
    `- turns inserted: ${r.load.turnsInserted}, skipped (dup): ${r.load.turnsSkipped}, errors: ${r.load.turnErrors.length}`,
    `- outcomes written: ${r.load.outcomesInserted}, skipped: ${r.load.outcomesSkipped}`,
    `- embed-queue delta (decision turns awaiting embedding): ${r.embedQueueDelta}`,
    r.degenerateSources.length > 0
      ? `- **HALT-worthy degenerate sources (0 triples): ${r.degenerateSources.join(', ')}**`
      : '- no degenerate sources',
    '',
  ];
  return lines.join('\n');
}

function logDryRun(r: DecisionDryRunReport, log: (l: string) => void): void {
  log(`[decision dry-run] ${r.totalTriples} triple(s) across ${r.perSource.length} source(s)`);
  for (const p of r.perSource) log(`  ${p.kind.padEnd(18)} ${p.triples} triple(s) from ${p.dir}`);
  log(
    `[decision dry-run] would write ${r.load.turnsInserted} turn(s) + ${r.load.outcomesInserted} outcome(s); embed-queue delta ${r.embedQueueDelta}`,
  );
  if (r.degenerateSources.length > 0)
    log(`[decision dry-run] HALT degenerate: ${r.degenerateSources.join(', ')}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--ingest');
  const force = argv.includes('--force');
  const outIdx = argv.indexOf('--out');
  const outPath =
    outIdx >= 0 && argv[outIdx + 1]
      ? argv[outIdx + 1]
      : `${homedir()}/notes/planning/2026-06-26/decision-etl-phase4-dryrun-report.md`;

  if (live) {
    const res = ingestLive({ force });
    if (res.halted) {
      console.error(`[decision ingest] HALT: ${res.reason}`);
      process.exitCode = 1;
    } else {
      console.log(
        `[decision ingest] ${res.totalTriples} triple(s) -> inserted ${res.load?.turnsInserted} turn(s), ${res.load?.outcomesInserted} outcome(s); embed-queue delta ${res.embedQueueDelta}`,
      );
      process.exitCode = 0;
    }
  } else {
    const r = dryRun();
    logDryRun(r, (l) => console.log(l));
    const md = renderDryRunReport(
      r,
      new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, md, 'utf-8');
    console.log(`[decision dry-run] report written to ${outPath}`);
    process.exitCode = 0;
  }
}

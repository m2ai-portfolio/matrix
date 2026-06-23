// Matrix Phase 2 - Mine v1 run entrypoint ("activate the analytics loop").
//
// This is the single scheduled caller that turns the built-but-idle Mine module
// into a running loop: open the warehouse corpus, run one mine pass, and (unless
// low-signal or --dry-run) write the findings to their sink. Like the fleet
// populate entrypoint, runMineV1/writeFindings are library functions with no
// caller of their own; this file supplies the wiring.
//
// SAFETY / ANTI-SLOP:
//   - The low-signal gate is honored HERE: when runMineV1 returns lowSignal=true
//     we write NOTHING (no daily-note section, no outcome rows). No filler.
//   - --dry-run runs the full read pass and prints findings but writes nothing,
//     so a pass can be inspected without touching the notes or the outcome table.
//   - The corpus DB (store/matrix.db) is opened read-write because writeFindings
//     records outcome rows there; the live claudeclaw.db is never opened.
//   - Lock-free by design: single-flight (flock) lives in the cron wrapper,
//     mirroring matrix-fleet-populate-cron.sh / src/fleet/populate-ccos.ts.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { runMineV1, type MineConfig, type MineResult } from './mine-v1.js';
import { writeFindings, type SinkConfig, type SinkResult } from './sink.js';

export interface MineRunOptions {
  /** Corpus DB path. Default = repo store/matrix.db. Pass a temp path in tests. */
  dbPath?: string;
  /** Pre-opened corpus handle (test injection). When set, dbPath is ignored and
   *  the caller owns close(); otherwise this entrypoint opens and closes its own. */
  db?: Database;
  /** Run the read pass and report, but write neither the note nor outcome rows. */
  dryRun?: boolean;
  /** MineConfig passthrough (tests inject projectDirMap / gitLastCommitMs / now). */
  mine?: MineConfig;
  /** SinkConfig passthrough (tests inject vaultDailyDir / now). */
  sink?: SinkConfig;
  /** Logger. Default console.log. */
  log?: (line: string) => void;
}

export interface MineRunOutcome {
  result: MineResult;
  /** Set only when findings were actually written (not low-signal, not dry-run). */
  sink?: SinkResult;
  wrote: boolean;
}

/**
 * Run exactly one mine pass. Opens the corpus (unless a handle is injected),
 * mines, and writes findings to their sink unless the pass is low-signal or
 * dry-run. The owned handle is always closed (finally).
 */
export async function mineOnce(opts: MineRunOptions = {}): Promise<MineRunOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const ownsDb = opts.db === undefined;
  const db: Database = opts.db ?? openDb(opts.dbPath);

  try {
    const result = await runMineV1(db, opts.mine ?? {});

    if (result.lowSignal) {
      log(
        `[mine] low signal: nothing cleared thresholds (scanned ${result.scannedProjects} project(s)); wrote nothing`,
      );
      return { result, wrote: false };
    }

    log(
      `[mine] ${result.findings.length} finding(s) from ${result.scannedProjects} scanned project(s):`,
    );
    for (const f of result.findings) log(`  - ${f.headline}`);

    if (opts.dryRun) {
      log('[mine] dry-run: note + outcome writes skipped');
      return { result, wrote: false };
    }

    const sink = writeFindings(db, result.findings, opts.sink ?? {});
    log(`[mine] wrote ${sink.outcomeRows} outcome row(s) -> ${sink.notePath}`);
    return { result, sink, wrote: true };
  } finally {
    if (ownsDb) db.close();
  }
}

/** Parse the handful of CLI flags this entrypoint accepts. */
export function parseMineArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes('--dry-run') || argv.includes('-n') };
}

// Auto-run only when invoked directly (node dist/mine/run.js), never on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { dryRun } = parseMineArgs(process.argv.slice(2));
  console.log(`Matrix mine run${dryRun ? ' (dry-run)' : ''}`);
  mineOnce({ dryRun })
    .then((o) => {
      console.log(`Matrix mine complete: wrote=${o.wrote} findings=${o.result.findings.length}`);
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Matrix mine failed: ${msg}`);
      process.exitCode = 1;
    });
}

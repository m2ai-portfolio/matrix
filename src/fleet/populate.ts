// Matrix Fleet Visibility - populate pass (docs/FLEET-VISIBILITY.md sec6).
//
// runPopulate refreshes the operational store by running the sync engine over a
// caller-supplied set of source adapters and a caller-supplied ops DB handle.
//
// SAFETY (FIX A / HARD #1 / HARD #2):
//   - opsDb is a REQUIRED, caller-owned handle. This module never opens a DB
//     itself, so it can never reach the corpus (store/matrix.db) or the live
//     claudeclaw.db.
//   - adapters is a REQUIRED parameter. There is NO default that constructs
//     createCcosNativeAdapter and NO zero-arg / zero-adapter path that reaches a
//     live source. The live ccos-native wiring is the HELD subtask 9 entrypoint,
//     built separately. There is intentionally NO import of the ccos-native
//     adapter in this file and NO isMain auto-run.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import type { FleetAdapter } from './adapter.js';
import { runSync, type SyncResult } from './sync.js';

/** Non-store options for a populate pass. */
export interface PopulateOptions {
  /** Logger. Default = console.log. Tests pass a spy. */
  log?: (line: string) => void;
  /** Injectable clock (ms), forwarded to runSync. Tests pass a fixed value. */
  now?: () => number;
}

export interface PopulateOutcome {
  results: SyncResult[];
  /**
   * 0 when at least one source succeeded, or when there were no sources to run
   * (nothing to do is not a failure). 1 only when there was at least one source
   * and EVERY source failed (sec5 kill posture: a single broken source degrades
   * to stale without taking down the refresh).
   */
  exitCode: number;
}

/** One-line human summary of a SyncResult. */
function formatResult(r: SyncResult): string {
  if (r.ok) {
    return `[populate] ${r.source}: ok agents=${r.agents} statuses=${r.statuses} newEvents=${r.newEvents}`;
  }
  return `[populate] ${r.source}: FAILED ${r.error ?? 'unknown error'}`;
}

/**
 * Run one populate pass.
 *
 * @param opsDb   REQUIRED caller-owned ops DB handle (opened/closed by the
 *                caller). This module never opens a DB, so it cannot reach the
 *                corpus or the live claudeclaw.db.
 * @param adapters REQUIRED list of source adapters. No default: callers must
 *                pass the sources explicitly, so no implicit live-DB source is
 *                ever constructed here. An empty list is "nothing to do".
 * @param opts    Optional logger / clock.
 */
export async function runPopulate(
  opsDb: Database,
  adapters: FleetAdapter[],
  opts: PopulateOptions = {},
): Promise<PopulateOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const results = await runSync(opsDb, adapters, { now: opts.now });

  for (const r of results) log(formatResult(r));

  const allFailed = results.length > 0 && results.every((r) => !r.ok);
  const exitCode = allFailed ? 1 : 0;
  log(`[populate] done: ${results.length} source(s), exitCode=${exitCode}`);

  return { results, exitCode };
}

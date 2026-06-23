// Matrix Fleet Visibility — sync engine (docs/FLEET-VISIBILITY.md §5).
//
// Pulls each source adapter independently and writes the result into the ops
// store. One source failing NEVER kills the others: a thrown adapter marks just
// its own source `stale` and is reported back, so the scheduler wrapper can
// enforce the per-source `kill` threshold (owner/sink/kill lives in the wrapper).

import type { Database } from 'better-sqlite3';
import type { FleetAdapter, Source } from './adapter.js';
import { ingestEvents, markSourceStale, upsertAgent, upsertStatus } from '../ops/queries.js';

/** Outcome of syncing one source in a single pass. */
export interface SyncResult {
  source: Source;
  ok: boolean;
  agents: number;
  statuses: number;
  /** New activity rows actually inserted (deduped). */
  newEvents: number;
  error?: string;
}

export interface SyncOptions {
  /** Injectable clock (ms). Defaults to Date.now. Tests pass a fixed value. */
  now?: () => number;
}

/**
 * Run one sync pass over all adapters. Returns one SyncResult per source.
 * Never throws: an adapter error is captured into its SyncResult and the source
 * is marked stale.
 */
export async function runSync(
  db: Database,
  adapters: FleetAdapter[],
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const now = opts.now ?? Date.now;
  const settled = await Promise.allSettled(adapters.map((a) => a.pull()));

  const results: SyncResult[] = [];
  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    const outcome = settled[i];
    const ts = now();

    if (outcome.status === 'rejected') {
      const error =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      markSourceStale(db, adapter.source, `sync failed: ${error}`, ts);
      results.push({
        source: adapter.source,
        ok: false,
        agents: 0,
        statuses: 0,
        newEvents: 0,
        error,
      });
      continue;
    }

    const pull = outcome.value;
    for (const a of pull.agents) upsertAgent(db, a, ts);
    for (const s of pull.statuses) upsertStatus(db, s, ts);
    const newEvents = ingestEvents(db, pull.events);

    results.push({
      source: adapter.source,
      ok: true,
      agents: pull.agents.length,
      statuses: pull.statuses.length,
      newEvents,
    });
  }

  return results;
}

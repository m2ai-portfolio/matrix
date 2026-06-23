// Matrix Fleet Visibility — live populate entrypoint (docs/FLEET-VISIBILITY.md §6).
//
// This is the HELD "subtask 9" wiring: the ONLY module that constructs a live
// source adapter and supplies it to runPopulate. populate.ts itself never reaches
// a live source (see its safety header) — the live wiring is isolated here so the
// blast radius of "what can open the live claudeclaw.db" is one small file.
//
// SAFETY:
//   - The live store (claudeclaw.db) is opened READ-ONLY inside the adapter
//     (readonly:true, fileMustExist:true; no injectable opener on its public API).
//     This entrypoint never writes the live store. The ops store (matrix-ops.db)
//     is the only DB opened read-write here.
//   - This file does NOT schedule itself. Wiring a cron / systemd unit is a
//     separate, human-approved step (No Orphan Loops). Single-flight overlap
//     protection (flock store/.fleet-populate.lock) lives in the cron wrapper,
//     mirroring src/bridge/run.ts + matrix-bridge-cron.sh.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import type { FleetAdapter, Source } from './adapter.js';
import { openOpsDb } from '../ops/open.js';
import { runPopulate, type PopulateOutcome } from './populate.js';
import { createCcosNativeAdapter } from './adapters/ccos-native.js';

/** Every source the board models (mirrors the Source union in adapter.ts). */
const KNOWN_SOURCES: readonly Source[] = ['ccos', 'cmd', 'hermes', 'vendor'];

/** Default source set when no --source flag is given. */
export const DEFAULT_SOURCES: Source[] = ['ccos'];

/**
 * Sources with a live adapter implemented TODAY. `cmd` / `hermes` / `vendor` are
 * roadmap (scale phase, docs/FLEET-VISIBILITY.md §"scale"): they are valid
 * --source values for forward-compat, but constructing one before its adapter
 * exists fails loudly rather than silently producing an empty board. Add the
 * factory here when the adapter lands — no other change needed.
 */
const ADAPTER_FACTORIES: Partial<Record<Source, () => FleetAdapter>> = {
  ccos: () => createCcosNativeAdapter(),
};

/** A Source the union accepts. Narrows an arbitrary string. */
function isKnownSource(s: string): s is Source {
  return (KNOWN_SOURCES as readonly string[]).includes(s);
}

/**
 * Parse the requested sources from CLI args. Accepts repeated flags and/or
 * comma lists, in either `--source ccos` or `--source=ccos,cmd` form. Unknown
 * tokens throw with the valid set. Empty / no flag → DEFAULT_SOURCES. Order is
 * preserved and duplicates collapse (first wins).
 */
export function parseSources(argv: string[]): Source[] {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        raw.push(next);
        i++;
      }
    } else if (arg.startsWith('--source=')) {
      raw.push(arg.slice('--source='.length));
    }
  }

  const tokens = raw
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (tokens.length === 0) return [...DEFAULT_SOURCES];

  const seen = new Set<Source>();
  const out: Source[] = [];
  for (const t of tokens) {
    if (!isKnownSource(t)) {
      throw new Error(`unknown --source '${t}' (valid: ${KNOWN_SOURCES.join(', ')})`);
    }
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Build the live adapters for the requested sources. Throws (listing what IS
 * available) if a source is valid but has no adapter yet, so an unbuilt source
 * never degrades silently to "no data".
 */
export function buildAdapters(sources: Source[]): FleetAdapter[] {
  const adapters: FleetAdapter[] = [];
  for (const s of sources) {
    const make = ADAPTER_FACTORIES[s];
    if (!make) {
      const available = Object.keys(ADAPTER_FACTORIES).join(', ') || '(none)';
      throw new Error(`no adapter implemented for source '${s}' (available: ${available})`);
    }
    adapters.push(make());
  }
  return adapters;
}

export interface PopulateOnceOptions {
  /** Sources to populate. Default DEFAULT_SOURCES. Ignored if `adapters` is set. */
  sources?: Source[];
  /** Pre-built adapters (test injection). When set, overrides `sources`. */
  adapters?: FleetAdapter[];
  /** Ops DB path. Default = repo store/matrix-ops.db. Pass ':memory:' in tests. */
  opsDbPath?: string;
  /** Logger. Default console.log. */
  log?: (line: string) => void;
}

/**
 * Run exactly one populate pass: open the ops store read-write, run the sync
 * engine over the source adapters, close the store. The ops handle is always
 * closed (finally), even on error. Never throws on a source failure — a broken
 * source degrades to `stale` and is reflected in the returned exitCode.
 */
export async function populateOnce(opts: PopulateOnceOptions = {}): Promise<PopulateOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const adapters = opts.adapters ?? buildAdapters(opts.sources ?? DEFAULT_SOURCES);

  const db: Database = openOpsDb(opts.opsDbPath);
  try {
    return await runPopulate(db, adapters, { log });
  } finally {
    db.close();
  }
}

// Auto-run only when invoked directly (node dist/fleet/populate-ccos.js), never
// on import. Mirrors src/bridge/run.ts.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let sources: Source[];
  try {
    sources = parseSources(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`Matrix fleet populate: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    sources = [];
  }

  if (sources.length > 0) {
    console.log(`Matrix fleet populate: sources=${sources.join(',')}`);
    populateOnce({ sources })
      .then((outcome) => {
        console.log(`Matrix fleet populate complete: exitCode=${outcome.exitCode}`);
        process.exitCode = outcome.exitCode;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Matrix fleet populate failed: ${msg}`);
        process.exitCode = 1;
      });
  }
}

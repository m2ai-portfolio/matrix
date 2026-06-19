// Matrix -> CCOS bridge — launchable loop entry (docs/ROUTING.md §"The bridge").
//
// This module makes the bridge loop RUNNABLE by an unattended scheduler without
// depending on the launch cwd. It constructs the REAL shell MissionApi (which
// now spawns mission-cli with cwd=claudeclaw-os so CCOS auto-loads its env) and
// calls runBridgeLoop with config drawn from env vars.
//
// NOTE: this file does NOT schedule itself. Wiring a cron / systemd unit is a
// separate, human-approved step (it trips the No Orphan Loops CronCreate gate).
// The owner/sink/kill guards are already declared in BRIDGE_LOOP_GUARDS (loop.ts).
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { BridgePass } from './bridge.js';
import { runBridgeLoop } from './loop.js';
import { createShellMissionApi, resolveCcosDir } from './mission.js';

/**
 * Default Matrix queue root if MATRIX_QUEUE_ROOT is unset. This is the canonical
 * routing-lane root (docs/ROUTING.md "Directory layout"): laneDirs() resolves
 * tasks/, tasks/claimed/, and results/ directly under it. It is NOT under store/
 * (store/ holds the gitignored corpus DB); queue/ tracks its README/.gitkeep while
 * gitignoring the runtime cards.
 */
export const DEFAULT_QUEUE_ROOT = '/opt/matrix/queue';
/** Default bridge agent id if BRIDGE_AGENT_ID is unset. */
export const DEFAULT_AGENT_ID = 'galvatron';

export interface BridgeRunConfig {
  /** CCOS agent whose task lane this run drains (card owner to match). */
  agentId: string;
  /** Matrix queue root (contains tasks/ + results/). */
  queueRoot: string;
  /** claudeclaw-os dir passed to the shell MissionApi as spawn cwd. */
  ccosDir: string;
  /** Safety bound on passes per run. */
  maxPasses: number;
}

/**
 * Resolve the run config from environment variables (all optional):
 *   BRIDGE_AGENT_ID    — CCOS agent id          (default galvatron)
 *   MATRIX_QUEUE_ROOT  — Matrix queue root       (default queue/)
 *   CLAUDECLAW_DIR     — claudeclaw-os checkout   (default via resolveCcosDir)
 *   BRIDGE_MAX_PASSES  — per-run pass cap         (default 100)
 */
export function resolveRunConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): BridgeRunConfig {
  const agentId = env.BRIDGE_AGENT_ID?.trim() || DEFAULT_AGENT_ID;
  const queueRoot = env.MATRIX_QUEUE_ROOT?.trim() || DEFAULT_QUEUE_ROOT;
  const ccosDir = resolveCcosDir(env.CLAUDECLAW_DIR?.trim() || undefined);

  let maxPasses = 100;
  const rawMax = env.BRIDGE_MAX_PASSES?.trim();
  if (rawMax && /^\d+$/.test(rawMax)) {
    const n = Number.parseInt(rawMax, 10);
    if (Number.isInteger(n) && n > 0) maxPasses = n;
  }

  return { agentId, queueRoot, ccosDir, maxPasses };
}

/**
 * Construct the real shell MissionApi and drain the agent's task lane once.
 * Returns every pass outcome so the caller can log/digest. The shell MissionApi
 * sets its spawn cwd to `ccosDir`, so this works regardless of process.cwd().
 */
export async function runBridgeOnce(
  config: BridgeRunConfig = resolveRunConfig(),
): Promise<BridgePass[]> {
  const mission = createShellMissionApi({ ccosDir: config.ccosDir });
  return runBridgeLoop({
    queueRoot: config.queueRoot,
    agentId: config.agentId,
    mission,
    maxPasses: config.maxPasses,
  });
}

// Auto-run only when invoked directly (node dist/bridge/run.js), never on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = resolveRunConfig();
  console.log(
    `Matrix bridge run: agent=${config.agentId} queueRoot=${config.queueRoot} ccosDir=${config.ccosDir} maxPasses=${config.maxPasses}`,
  );
  runBridgeOnce(config)
    .then((passes) => {
      const counts: Record<string, number> = {};
      for (const p of passes) counts[p.outcome] = (counts[p.outcome] ?? 0) + 1;
      console.log(
        `Matrix bridge run complete: ${passes.length} pass(es) ${JSON.stringify(counts)}`,
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Matrix bridge run failed: ${msg}`);
      process.exitCode = 1;
    });
}

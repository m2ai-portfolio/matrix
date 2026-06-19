// Matrix -> CCOS task-lane bridge — scheduled loop wrapper.
//
// ============================ NO ORPHAN LOOPS ============================
// This is a scheduled loop. Per ~/.claude/rules/loop-and-queue-convention.md it
// declares the three guards with REAL values or it does not ship:
//
//   owner: the bridge sidecar process (this module, run under the bridge agent id)
//   sink:  CCOS mission_tasks (enqueue side) + the Matrix result card / results/
//          return lane (completion side). Every pass writes its outcome to one of
//          these durable destinations; nothing logs to nowhere.
//   kill:  per-card `kill` (max attempts). On the kill-th claim/exec failure the
//          card is set status=blocked and escalated to its requester via the
//          card's sink. The loop itself ends when a pass returns "idle"
//          (no claimable cards) for a full sweep.
// ========================================================================
//
// The wrapper is intentionally thin: all routing logic lives in bridgePass. This
// file exists so the guard declaration is grep-able and the loop has one entry
// point a scheduler / cron / /loop can call.

import { bridgePass, type BridgeOptions, type BridgePass } from './bridge.js';
import { createShellMissionApi, type MissionApi } from './mission.js';

/** The three No-Orphan-Loops guards, declared as data so they are inspectable. */
export const BRIDGE_LOOP_GUARDS = {
  owner: 'matrix-ccos-bridge',
  sink: 'ccos:mission_tasks + matrix:results/',
  kill: 'per-card kill (attempts >= kill -> blocked + escalate to requester)',
} as const;

export interface BridgeLoopOptions extends BridgeOptions {
  /** MissionApi to use. Defaults to the real shell-out to CCOS mission-cli. */
  mission?: MissionApi;
  /** Bridge agent id (the CCOS agent whose cards this loop serves). */
  agentId: string;
  /** Matrix queue root. */
  queueRoot: string;
  /** Max passes before yielding (safety bound so a single run can't spin forever). */
  maxPasses?: number;
}

/**
 * Drain one CCOS agent's task lane: repeatedly bridgePass until a pass returns
 * "idle" (nothing left to claim AND nothing in flight) or maxPasses is hit.
 * Returns every pass outcome for the caller's digest/sink.
 */
export async function runBridgeLoop(opts: BridgeLoopOptions): Promise<BridgePass[]> {
  const mission = opts.mission ?? createShellMissionApi();
  const maxPasses = opts.maxPasses ?? 100;
  const passes: BridgePass[] = [];

  for (let i = 0; i < maxPasses; i++) {
    const pass = await bridgePass(opts.queueRoot, opts.agentId, mission, {
      now: opts.now,
      returnOpts: opts.returnOpts,
    });
    passes.push(pass);
    // "pending" means an in-flight CCOS task isn't done yet — stop this run and
    // let the next scheduled pass poll it (don't busy-wait on the network).
    if (pass.outcome === 'idle' || pass.outcome === 'pending') break;
  }

  return passes;
}

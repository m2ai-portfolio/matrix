// Matrix -> CCOS task-lane bridge loop (docs/ROUTING.md §"The bridge").
//
// owner: the bridge sidecar (this loop)
// sink:  CCOS mission_tasks (enqueue) + the Matrix result card / return lane
// kill:  N claim/exec failures -> card `blocked`, escalate to requester
//
// The bridge is the adapter that lets LOCAL CCOS agents participate in the
// neutral Matrix bus without any change to upstream claudeclaw-os. Per pass it:
//   1. claim()s the next Matrix task card addressed to a CCOS agent it serves.
//   2. enqueues it into CCOS via the sanctioned mission-cli (MissionApi.create),
//      recording the returned CCOS task id on the Matrix card so the enqueue is
//      idempotent (a re-run never double-enqueues).
//   3. polls MissionApi.result; on terminal success, returns the result back to
//      Matrix per the card's sink (results/ lane by default).
//
// External off-box agents skip the bridge and speak the card contract directly.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { laneDirs, readCardFile, writeCardFile, type Card } from '../queue/card.js';
import { claim, sweepStaleClaims } from '../queue/claim.js';
import { returnResult, type ReturnOptions, type ReturnOutcome } from '../queue/return.js';
import type { MissionApi } from './mission.js';

/** Marker line prefix used to persist the CCOS task id on a Matrix card's notes. */
const CCOS_TASK_MARKER = 'ccos-task-id:';

export interface BridgeOptions {
  /** Clock (ms) for claim/lease. Defaults to Date.now. */
  now?: () => number;
  /** Return-path options (telegram sender, result-card clock). */
  returnOpts?: ReturnOptions;
}

/** Result of one bridge pass over one card. */
export interface BridgePass {
  /** "enqueued" | "completed" | "pending" | "failed" | "idle" | "blocked" */
  outcome: 'enqueued' | 'completed' | 'pending' | 'failed' | 'idle' | 'blocked';
  matrixCardId?: string;
  ccosTaskId?: string;
  returned?: ReturnOutcome;
}

/** Read the CCOS task id previously stamped on a card, if any. */
function readCcosTaskId(card: Card): string | null {
  for (const line of card.notes.split('\n')) {
    const t = line.trim();
    if (t.startsWith(CCOS_TASK_MARKER)) {
      const id = t.slice(CCOS_TASK_MARKER.length).trim();
      return id === '' ? null : id;
    }
  }
  return null;
}

/** Stamp the CCOS task id onto a card's notes (idempotent — replaces if present). */
function stampCcosTaskId(card: Card, ccosId: string): Card {
  const kept = card.notes.split('\n').filter((l) => !l.trim().startsWith(CCOS_TASK_MARKER));
  const notes = [...kept, `${CCOS_TASK_MARKER} ${ccosId}`].join('\n').trim();
  return { ...card, notes };
}

/** Find an in-flight claimed card owned by `agentId` (already claimed this run). */
function findClaimedFor(queueRoot: string, agentId: string): { card: Card; path: string } | null {
  const { claimed } = laneDirs(queueRoot);
  if (!existsSync(claimed)) return null;
  for (const name of readdirSync(claimed)) {
    if (!name.endsWith(`.${agentId}.md`)) continue;
    const path = join(claimed, name);
    try {
      const card = readCardFile(path);
      if (card.status === 'doing' && card.owner === agentId) {
        return { card, path };
      }
    } catch {
      // skip unparseable
    }
  }
  return null;
}

/**
 * Run a single bridge pass for one CCOS agent.
 *
 * Idempotency contract: enqueue happens exactly once per Matrix card. The CCOS
 * task id is persisted to the card's notes immediately after create(); a re-run
 * sees the marker and resumes at the poll step instead of enqueuing again.
 *
 * @param queueRoot Matrix queue root (contains tasks/ + results/)
 * @param agentId the CCOS agent this bridge serves (card owner to match)
 * @param mission the injected MissionApi (real shell-out or a test mock)
 */
export async function bridgePass(
  queueRoot: string,
  agentId: string,
  mission: MissionApi,
  opts: BridgeOptions = {},
): Promise<BridgePass> {
  // Recover any leases that died mid-flight before claiming new work.
  sweepStaleClaims(queueRoot, { now: opts.now });

  // Resume an already-claimed in-flight card first (poll-and-return), so a
  // re-run completes pending work rather than starting more.
  let inflight = findClaimedFor(queueRoot, agentId);
  if (!inflight) {
    const claimed = claim(queueRoot, agentId, { now: opts.now });
    if (!claimed) return { outcome: 'idle' };
    inflight = { card: claimed.card, path: claimed.path };
  }

  let { card } = inflight;
  const { path } = inflight;

  // Step 1: ensure the card is enqueued into CCOS exactly once.
  let ccosId = readCcosTaskId(card);
  if (ccosId === null) {
    const created = await mission.create({
      agent: agentId,
      title: card.title,
      prompt: card.action,
      priority: card.priority,
    });
    ccosId = created.id;
    card = stampCcosTaskId(card, ccosId);
    writeCardFile(path, card);
    return { outcome: 'enqueued', matrixCardId: card.id, ccosTaskId: ccosId };
  }

  // Step 2: poll CCOS for completion.
  const res = await mission.result(ccosId);
  const status = res.status.toLowerCase();

  if (status === 'completed' || status === 'done' || status === 'success') {
    const returned = await returnResult(
      queueRoot,
      card,
      res.result ?? '(no result text)',
      path,
      opts.returnOpts,
    );
    return {
      outcome: 'completed',
      matrixCardId: card.id,
      ccosTaskId: ccosId,
      returned,
    };
  }

  if (status === 'failed' || status === 'cancelled' || status === 'error') {
    // Failure path: escalate per kill. attempts was already incremented at claim.
    if (card.attempts >= card.kill) {
      const blocked: Card = {
        ...card,
        status: 'blocked',
        notes: appendNote(
          card.notes,
          `ccos task ${ccosId} ${status}; attempts ${card.attempts} >= kill ${card.kill} -> blocked, escalate to ${card.requester} via ${card.sink}`,
        ),
      };
      writeCardFile(path, blocked);
      return { outcome: 'blocked', matrixCardId: card.id, ccosTaskId: ccosId };
    }
    // Under kill: clear the CCOS marker and return the card to todo for retry.
    const { tasks } = laneDirs(queueRoot);
    const retry: Card = {
      ...card,
      status: 'todo',
      claimed_by: null,
      claimed_at: null,
      notes: card.notes
        .split('\n')
        .filter((l) => !l.trim().startsWith(CCOS_TASK_MARKER))
        .join('\n')
        .trim(),
    };
    writeCardFile(join(tasks, `${card.id}.md`), retry);
    if (existsSync(path)) rmSync(path);
    return { outcome: 'failed', matrixCardId: card.id, ccosTaskId: ccosId };
  }

  // queued | running | unknown -> still pending, leave in flight.
  return { outcome: 'pending', matrixCardId: card.id, ccosTaskId: ccosId };
}

function appendNote(existing: string, line: string): string {
  const trimmed = existing.trim();
  return trimmed === '' ? line : `${trimmed}\n${line}`;
}

// Matrix inter-agent routing lane — claim + lease + stale-claim recovery
// (docs/ROUTING.md §"Claim semantics", §"lease recovery").
//
// File-queue mutual exclusion with NO database lock: rename() within one
// filesystem is atomic and IS the mutex. The winner of the rename owns the card;
// every loser's rename throws ENOENT and moves on. No card runs twice; no card
// is lost on holder death (an expired lease returns it to todo, or blocks it
// once attempts reach kill). This is the file-queue analog of CCOS
// resetStuckMissionTasks.

import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  laneDirs,
  nextCardId,
  readCardFile,
  scanCardIds,
  writeCardFile,
  type Card,
} from './card.js';

export interface ClaimOptions {
  /** Injectable clock (ms). Defaults to Date.now. Tests pass a fixed value. */
  now?: () => number;
}

/** Result of a successful claim: the claimed card and its on-disk path. */
export interface ClaimedCard {
  card: Card;
  /** Path inside tasks/claimed/, e.g. .../tasks/claimed/T-...0001.galvatron.md */
  path: string;
}

/** Map a bare card id to its claimed-file name for a given agent. */
function claimedFileName(id: string, agentId: string): string {
  return `${id}.${agentId}.md`;
}

/** True when every dependency id appears in `doneIds`. */
function dependenciesSatisfied(card: Card, doneIds: Set<string>): boolean {
  return card.depends_on.every((dep) => doneIds.has(dep));
}

/**
 * Collect the ids of cards that are already `done` across the lane, so
 * depends_on can be evaluated. A card is considered done if a result card for
 * it exists in results/ OR a claimed card carries status `done`.
 */
function collectDoneIds(queueRoot: string): Set<string> {
  const { results, claimed } = laneDirs(queueRoot);
  const done = new Set<string>();
  for (const dir of [results, claimed]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      try {
        const card = readCardFile(join(dir, name));
        if (card.status === 'done') done.add(card.id);
      } catch {
        // ignore unparseable / partially-written files during a scan
      }
    }
  }
  return done;
}

/**
 * Attempt to claim the next eligible todo card for `agentId` from tasks/.
 *
 * Eligibility: owner == agentId, status == todo, all depends_on are done.
 * Cards are tried in priority order (higher first), then by id (FIFO same-day).
 *
 * The claim itself is an atomic rename tasks/T-x.md -> tasks/claimed/T-x.<agent>.md.
 * The winner then stamps status=doing, attempts+=1, claimed_by, claimed_at and
 * rewrites the file in place. A loser's rename throws ENOENT; we catch it and
 * try the next candidate. Returns null when nothing is claimable.
 */
export function claim(
  queueRoot: string,
  agentId: string,
  opts: ClaimOptions = {},
): ClaimedCard | null {
  const now = opts.now ?? Date.now;
  const { tasks, claimed } = laneDirs(queueRoot);
  if (!existsSync(tasks)) return null;

  const doneIds = collectDoneIds(queueRoot);

  const candidates: { card: Card; src: string }[] = [];
  for (const name of readdirSync(tasks)) {
    if (!name.startsWith('T-') || !name.endsWith('.md')) continue;
    const src = join(tasks, name);
    // Skip directories (e.g. claimed/) and only consider regular files.
    if (!statSync(src).isFile()) continue;
    let card: Card;
    try {
      card = readCardFile(src);
    } catch {
      continue; // unparseable / mid-write — skip this pass
    }
    if (card.owner !== agentId) continue;
    if (card.status !== 'todo') continue;
    if (!dependenciesSatisfied(card, doneIds)) continue;
    candidates.push({ card, src });
  }

  // Priority desc, then id asc (stable FIFO for same priority/day).
  candidates.sort((a, b) => {
    if (b.card.priority !== a.card.priority) return b.card.priority - a.card.priority;
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
  });

  for (const { card, src } of candidates) {
    const dest = join(claimed, claimedFileName(card.id, agentId));
    try {
      // Atomic mutex. If another claimer already moved this file, this throws ENOENT.
      renameSync(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // lost the race; try the next candidate
      throw err;
    }
    // We own it. Stamp the lease and persist in place.
    const ts = now();
    const claimedCard: Card = {
      ...card,
      status: 'doing',
      attempts: card.attempts + 1,
      claimed_by: agentId,
      claimed_at: ts,
    };
    writeCardFile(dest, claimedCard);
    return { card: claimedCard, path: dest };
  }

  return null;
}

export interface SweepOptions {
  now?: () => number;
}

/** What happened to one card during a stale-claim sweep. */
export interface SweepOutcome {
  id: string;
  /** "returned" -> back to tasks/ as todo; "blocked" -> stayed, status=blocked. */
  action: 'returned' | 'blocked';
  attempts: number;
}

/**
 * Sweep tasks/claimed/ for cards whose lease has expired
 * (claimed_at + lease_ms < now). Each expired card is either:
 *  - returned to tasks/ as `todo` (cleared claim fields), if attempts < kill; or
 *  - left in claimed/ marked `blocked`, if attempts >= kill (escalation is the
 *    caller's job via the card's sink).
 *
 * Cards with status `done` are ignored (they are awaiting result-return / GC).
 * A non-expired in-flight card is left untouched.
 */
export function sweepStaleClaims(queueRoot: string, opts: SweepOptions = {}): SweepOutcome[] {
  const now = opts.now ?? Date.now;
  const { tasks, claimed } = laneDirs(queueRoot);
  if (!existsSync(claimed)) return [];

  const outcomes: SweepOutcome[] = [];
  const ts = now();

  for (const name of readdirSync(claimed)) {
    if (!name.startsWith('T-') || !name.endsWith('.md')) continue;
    const path = join(claimed, name);
    let card: Card;
    try {
      card = readCardFile(path);
    } catch {
      continue;
    }
    if (card.status === 'done' || card.status === 'blocked') continue;
    if (card.claimed_at === null) continue;

    const expired = card.claimed_at + card.lease_ms < ts;
    if (!expired) continue;

    if (card.attempts >= card.kill) {
      // Exhausted the retry budget — block in place for escalation.
      const blocked: Card = {
        ...card,
        status: 'blocked',
        notes: appendNote(
          card.notes,
          `lease expired at ${ts}; attempts ${card.attempts} >= kill ${card.kill} -> blocked`,
        ),
      };
      writeCardFile(path, blocked);
      outcomes.push({
        id: card.id,
        action: 'blocked',
        attempts: card.attempts,
      });
    } else {
      // Return to tasks/ as a fresh todo (clear the claim, keep attempts).
      const returned: Card = {
        ...card,
        status: 'todo',
        claimed_by: null,
        claimed_at: null,
        notes: appendNote(
          card.notes,
          `lease expired at ${ts}; returned to todo (attempt ${card.attempts}/${card.kill})`,
        ),
      };
      const dest = join(tasks, `${card.id}.md`);
      // Write the returned todo card to tasks/ first, then drop the claimed copy.
      // The claimed name is unique to the dead holder, so even if a fresh claimer
      // grabs the returned card before cleanup, the two files never collide.
      writeCardFile(dest, returned);
      if (existsSync(path)) rmSync(path);
      outcomes.push({
        id: card.id,
        action: 'returned',
        attempts: card.attempts,
      });
    }
  }

  return outcomes;
}

function appendNote(existing: string, line: string): string {
  const trimmed = existing.trim();
  return trimmed === '' ? line : `${trimmed}\n${line}`;
}

/**
 * Convenience: compute the next T- id for this queue root by scanning all three
 * lane dirs (tasks/, claimed/, results/) so same-day sequencing accounts for
 * already-claimed and already-returned cards.
 */
export function nextIdForQueue(queueRoot: string, now?: Date): string {
  const { tasks, claimed, results } = laneDirs(queueRoot);
  const ids = scanCardIds([tasks, claimed, results]);
  return nextCardId(ids, now);
}

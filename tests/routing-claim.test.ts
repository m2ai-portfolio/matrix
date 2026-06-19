// Matrix routing lane — claim + lease + stale-claim recovery tests
// (docs/ROUTING.md §"Claim semantics").
//
// Uses a real temp dir on disk because atomic rename() IS the mutex under test;
// :memory: has no filesystem. Each test gets an isolated mkdtemp dir, cleaned up.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneDirs, makeCard, readCardFile, writeCardFile, type Card } from '../src/queue/card.js';
import { claim, sweepStaleClaims, nextIdForQueue } from '../src/queue/claim.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'matrix-claim-'));
  const { tasks, claimed, results } = laneDirs(root);
  for (const d of [tasks, claimed, results]) mkdirSync(d, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function drop(overrides: Partial<Parameters<typeof makeCard>[0]> = {}): Card {
  const { tasks } = laneDirs(root);
  const id = overrides.id ?? nextIdForQueue(root, new Date(2026, 5, 15));
  const card = makeCard({
    id,
    title: 'do a thing',
    owner: 'galvatron',
    requester: 'data',
    action: 'Run the thing.',
    doneWhen: 'The thing ran.',
    now: new Date(2026, 5, 15),
    ...overrides,
  });
  writeCardFile(join(tasks, `${id}.md`), card);
  return card;
}

describe('claim', () => {
  it('claims an eligible todo card and stamps doing/attempts/claimed_by/at', () => {
    const card = drop();
    const claimed = claim(root, 'galvatron', { now: () => 1000 });
    expect(claimed).not.toBeNull();
    expect(claimed!.card.id).toBe(card.id);
    expect(claimed!.card.status).toBe('doing');
    expect(claimed!.card.attempts).toBe(1);
    expect(claimed!.card.claimed_by).toBe('galvatron');
    expect(claimed!.card.claimed_at).toBe(1000);

    // The source file moved out of tasks/ into claimed/ (atomic rename).
    const { tasks, claimed: claimedDir } = laneDirs(root);
    expect(existsSync(join(tasks, `${card.id}.md`))).toBe(false);
    expect(readdirSync(claimedDir)).toContain(`${card.id}.galvatron.md`);
  });

  it('only claims cards owned by self', () => {
    drop({ owner: 'soundwave' });
    expect(claim(root, 'galvatron')).toBeNull();
  });

  it('skips a card whose depends_on is not yet done', () => {
    const dep = drop({ id: 'T-20260615-0001' });
    drop({ id: 'T-20260615-0002', depends_on: [dep.id] });
    // dep is still todo, so the dependent must not claim.
    const c = claim(root, 'galvatron');
    expect(c!.card.id).toBe('T-20260615-0001'); // the dependency itself
    // Mark dep done (simulate result), now the dependent becomes claimable.
    const { results } = laneDirs(root);
    const done = { ...dep, status: 'done' as const };
    writeCardFile(join(results, `${dep.id}.md`), done);
    const c2 = claim(root, 'galvatron');
    expect(c2!.card.id).toBe('T-20260615-0002');
  });

  it('claims higher priority first', () => {
    drop({ id: 'T-20260615-0001', priority: 1 });
    drop({ id: 'T-20260615-0002', priority: 9 });
    expect(claim(root, 'galvatron')!.card.id).toBe('T-20260615-0002');
  });

  it('returns null when nothing is claimable', () => {
    expect(claim(root, 'galvatron')).toBeNull();
  });
});

describe('concurrency: two racing claimers', () => {
  it('exactly one wins a single card; the loser gets null (ENOENT) and continues', () => {
    drop({ id: 'T-20260615-0001' });
    // Both claimers scan the same single card, then race the rename.
    const a = claim(root, 'galvatron', { now: () => 1 });
    const b = claim(root, 'galvatron', { now: () => 2 });
    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
    // The card ran exactly once (attempts == 1, one claimed file).
    const { claimed } = laneDirs(root);
    expect(readdirSync(claimed).filter((n) => n.endsWith('.md'))).toHaveLength(1);
    expect(winners[0]!.card.attempts).toBe(1);
  });
});

describe('lease + stale-claim recovery', () => {
  it('returns an expired-lease card to todo (dead holder), attempts preserved', () => {
    drop({ id: 'T-20260615-0001', lease_ms: 100 });
    const claimed = claim(root, 'galvatron', { now: () => 1000 });
    expect(claimed!.card.attempts).toBe(1);

    // now far past claimed_at + lease_ms -> reclaimable.
    const outcomes = sweepStaleClaims(root, { now: () => 5000 });
    expect(outcomes).toEqual([{ id: 'T-20260615-0001', action: 'returned', attempts: 1 }]);

    const { tasks, claimed: claimedDir } = laneDirs(root);
    expect(existsSync(join(tasks, 'T-20260615-0001.md'))).toBe(true);
    expect(readdirSync(claimedDir).filter((n) => n.endsWith('.md'))).toHaveLength(0);
    const returned = readCardFile(join(tasks, 'T-20260615-0001.md'));
    expect(returned.status).toBe('todo');
    expect(returned.claimed_by).toBeNull();
    expect(returned.attempts).toBe(1); // not reset

    // A fresh claimer can now grab it again (no card lost on holder death).
    const reclaimed = claim(root, 'galvatron', { now: () => 6000 });
    expect(reclaimed!.card.id).toBe('T-20260615-0001');
    expect(reclaimed!.card.attempts).toBe(2);
  });

  it('blocks (not returns) an expired card once attempts >= kill', () => {
    drop({ id: 'T-20260615-0001', lease_ms: 100, kill: 1 });
    claim(root, 'galvatron', { now: () => 1000 }); // attempts -> 1 == kill
    const outcomes = sweepStaleClaims(root, { now: () => 5000 });
    expect(outcomes).toEqual([{ id: 'T-20260615-0001', action: 'blocked', attempts: 1 }]);
    const { claimed } = laneDirs(root);
    const blocked = readCardFile(join(claimed, 'T-20260615-0001.galvatron.md'));
    expect(blocked.status).toBe('blocked');
  });

  it('leaves a non-expired in-flight card untouched', () => {
    drop({ id: 'T-20260615-0001', lease_ms: 10_000 });
    claim(root, 'galvatron', { now: () => 1000 });
    const outcomes = sweepStaleClaims(root, { now: () => 1500 }); // within lease
    expect(outcomes).toEqual([]);
  });
});

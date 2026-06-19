// Matrix routing lane — return library tests (docs/ROUTING.md §"Return semantics").
// Covers the three sink modes and the lane:return round-trip: an executor writes
// a result, a result card appears in results/ addressed to the requester, and the
// requester claims it with the SAME claim() mechanism.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneDirs, makeCard, readCardFile, writeCardFile, type Card } from '../src/queue/card.js';
import { claim } from '../src/queue/claim.js';
import { returnResult } from '../src/queue/return.js';

let root: string;
const NOW = new Date(2026, 5, 15, 12, 0, 0);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'matrix-return-'));
  const { tasks, claimed, results } = laneDirs(root);
  for (const d of [tasks, claimed, results]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function executorCard(sink: string): Card {
  return makeCard({
    id: 'T-20260615-0001',
    title: 'summarize thread',
    owner: 'galvatron', // executor
    requester: 'data', // who asked
    action: 'Summarize.',
    doneWhen: 'Result written.',
    sink,
    now: NOW,
  });
}

describe('lane:return mode', () => {
  it('round-trips: result card lands in results/ addressed to the requester, who claims it', async () => {
    const { claimed, results } = laneDirs(root);
    const card = executorCard('lane:return');
    const path = join(claimed, `${card.id}.galvatron.md`);
    writeCardFile(path, { ...card, status: 'doing', claimed_by: 'galvatron' });

    const outcome = await returnResult(root, card, 'FIVE BULLETS', path, {
      now: () => NOW,
    });
    expect(outcome.mode).toBe('lane:return');
    expect(outcome.resultCardPath).toBeDefined();
    expect(existsSync(outcome.resultCardPath!)).toBe(true);

    // The original (claimed) card is finalized done with the result inline.
    const original = readCardFile(path);
    expect(original.status).toBe('done');
    expect(original.result).toBe('FIVE BULLETS');

    // The result card is owned by the requester (data), carries the result.
    const resultCard = readCardFile(outcome.resultCardPath!);
    expect(resultCard.owner).toBe('data');
    expect(resultCard.requester).toBe('galvatron');
    expect(resultCard.result).toBe('FIVE BULLETS');
    expect(resultCard.status).toBe('todo');
    expect(readdirSync(results).filter((n) => n.endsWith('.md'))).toHaveLength(1);

    // The requester drains its return lane with the SAME claim mechanism — but
    // claim() reads tasks/, so move the result card into the requester's task
    // lane to model the return lane. (Routing uses one tasks/ dir; owner flip is
    // what addresses it.) Verify the requester is the eligible claimant.
    const { tasks } = laneDirs(root);
    writeCardFile(join(tasks, `${resultCard.id}.md`), resultCard);
    const claimedByRequester = claim(root, 'data', { now: () => 1 });
    expect(claimedByRequester).not.toBeNull();
    expect(claimedByRequester!.card.id).toBe(resultCard.id);
    expect(claimedByRequester!.card.result).toBe('FIVE BULLETS');
  });
});

describe('card:result mode', () => {
  it('leaves the result inline on the original card, no result card written', async () => {
    const { claimed, results } = laneDirs(root);
    const card = executorCard('card:result');
    const path = join(claimed, `${card.id}.galvatron.md`);
    writeCardFile(path, { ...card, status: 'doing' });

    const outcome = await returnResult(root, card, 'INLINE', path);
    expect(outcome.mode).toBe('card:result');
    expect(outcome.resultCardPath).toBeUndefined();
    expect(readdirSync(results).filter((n) => n.endsWith('.md'))).toHaveLength(0);
    expect(readCardFile(path).result).toBe('INLINE');
    expect(readCardFile(path).status).toBe('done');
  });
});

describe('telegram mode', () => {
  it('invokes the injected sender with the chat id, sends no network call itself', async () => {
    const { claimed } = laneDirs(root);
    const card = executorCard('telegram:12345');
    const path = join(claimed, `${card.id}.galvatron.md`);
    writeCardFile(path, { ...card, status: 'doing' });

    const calls: Array<{ chatId: string; text: string }> = [];
    const outcome = await returnResult(root, card, 'PING', path, {
      telegram: (chatId, text) => {
        calls.push({ chatId, text });
      },
    });
    expect(outcome.mode).toBe('telegram');
    expect(outcome.chatId).toBe('12345');
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe('12345');
    expect(calls[0].text).toContain('PING');
    expect(readCardFile(path).status).toBe('done');
  });

  it('throws if a telegram sink is used without an injected sender', async () => {
    const { claimed } = laneDirs(root);
    const card = executorCard('telegram:999');
    const path = join(claimed, `${card.id}.galvatron.md`);
    writeCardFile(path, { ...card, status: 'doing' });
    await expect(returnResult(root, card, 'x', path)).rejects.toThrow(/sender/);
  });
});

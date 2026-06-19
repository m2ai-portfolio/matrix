// Matrix routing lane — card (de)serializer tests (docs/ROUTING.md §"Task card schema").
// Covers: owner/sink/kill guards present, T- id same-day sequencing, lossless round-trip.

import { describe, it, expect } from 'vitest';
import {
  CardValidationError,
  assertGuards,
  dateStamp,
  makeCard,
  nextCardId,
  parseCard,
  serializeCard,
  type Card,
} from '../src/queue/card.js';

const NOW = new Date(2026, 5, 15, 9, 0, 0); // 2026-06-15 local

function sampleCard(overrides: Partial<Card> = {}): Card {
  const base = makeCard({
    id: 'T-20260615-0001',
    title: 'Summarize the Atlantic thread',
    owner: 'galvatron',
    requester: 'data',
    action: 'Summarize conversation T-20260615-0001 into 5 bullets.',
    doneWhen: 'A 5-bullet summary is written to ## Result.',
    now: NOW,
  });
  return { ...base, ...overrides };
}

describe('routing card guards', () => {
  it('makeCard produces a card with all three guards present (owner/sink/kill)', () => {
    const card = sampleCard();
    expect(card.owner).toBe('galvatron');
    expect(card.sink).toBe('lane:return');
    expect(card.kill).toBe(3);
    expect(() => assertGuards(card)).not.toThrow();
  });

  it('rejects a card missing owner', () => {
    expect(() => assertGuards({ sink: 'lane:return', kill: 3 })).toThrow(CardValidationError);
    expect(() => assertGuards({ sink: 'lane:return', kill: 3 })).toThrow(/owner/);
  });

  it('rejects placeholder guard values (none / tbd / empty)', () => {
    expect(() => assertGuards({ owner: 'none', sink: 'lane:return', kill: 3 })).toThrow(/owner/);
    expect(() => assertGuards({ owner: 'data', sink: 'tbd', kill: 3 })).toThrow(/sink/);
    expect(() => assertGuards({ owner: 'data', sink: 'lane:return', kill: 0 })).toThrow(/kill/);
  });

  it('serializeCard refuses to write a guardless card', () => {
    const bad = { ...sampleCard(), owner: '' } as Card;
    expect(() => serializeCard(bad)).toThrow(CardValidationError);
  });

  it('parseCard refuses to parse a card whose front-matter drops a guard', () => {
    const text = serializeCard(sampleCard()).replace(/^sink: .*$/m, 'sink: none');
    expect(() => parseCard(text)).toThrow(/sink/);
  });
});

describe('T- id same-day sequencing', () => {
  it('increments NNNN within the same day', () => {
    const day = new Date(2026, 5, 15);
    expect(nextCardId([], day)).toBe('T-20260615-0001');
    expect(nextCardId(['T-20260615-0001'], day)).toBe('T-20260615-0002');
    expect(nextCardId(['T-20260615-0001', 'T-20260615-0002', 'T-20260615-0005'], day)).toBe(
      'T-20260615-0006',
    ); // max + 1, not count + 1
  });

  it("restarts at 0001 on a new day and ignores other days' ids", () => {
    const day = new Date(2026, 5, 16);
    expect(nextCardId(['T-20260615-0009'], day)).toBe('T-20260616-0001');
    expect(dateStamp(day)).toBe('20260616');
  });
});

describe('round-trip', () => {
  it('write -> parse is lossless for all fields and sections', () => {
    const card = sampleCard({
      depends_on: ['T-20260615-0000'],
      priority: 8,
      attempts: 2,
      claimed_by: 'galvatron',
      claimed_at: 1_700_000_000_000,
      status: 'doing',
      result: 'five bullets here',
      notes: 'a note\nsecond line',
    });
    const parsed = parseCard(serializeCard(card));
    expect(parsed).toEqual(card);
  });

  it('preserves an empty depends_on as [] and null claim fields as null', () => {
    const card = sampleCard();
    const parsed = parseCard(serializeCard(card));
    expect(parsed.depends_on).toEqual([]);
    expect(parsed.claimed_by).toBeNull();
    expect(parsed.claimed_at).toBeNull();
  });
});

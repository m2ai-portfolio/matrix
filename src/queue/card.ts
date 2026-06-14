// Matrix Phase 0 — central drop-queue Card contract (No Orphan Loops).
// Builder implementation. Spec claims: C-19, C-20, C-33.
// Convention: ~/.claude/rules/loop-and-queue-convention.md + queue/README.md.

export type CardStatus = 'todo' | 'doing' | 'done' | 'blocked';

/**
 * A drop-queue card. The three guards owner/sink/kill are REQUIRED (C-19).
 * A card missing any of them must be refused by the poller (C-20).
 */
export interface Card {
  id: string;
  title: string;
  status: CardStatus;
  owner: string; // GUARD 1 — who drains this
  sink: string; // GUARD 2 — where the result lands
  kill: number; // GUARD 3 — max attempts before blocked + escalate
  attempts: number;
  source: string;
  created: string;
  action?: string;
  doneWhen?: string;
  notes?: string;
}

/** Raw card before guard validation (guards may be absent). */
export type RawCard = Partial<Card> & { id?: string };

/** Typed error thrown when a card is missing a required guard (C-20). */
export class MissingGuardError extends Error {
  constructor(
    public readonly missing: ReadonlyArray<'owner' | 'sink' | 'kill'>,
    public readonly cardId?: string,
  ) {
    super(`card ${cardId ?? '<no-id>'} missing required guard(s): ${missing.join(', ')}`);
    this.name = 'MissingGuardError';
  }
}

const GUARDS = ['owner', 'sink', 'kill'] as const;
type Guard = (typeof GUARDS)[number];

/** Return the list of guards that are absent (undefined/null) on the raw card. */
function missingGuards(raw: RawCard): Guard[] {
  const missing: Guard[] = [];
  if (raw.owner === undefined || raw.owner === null) missing.push('owner');
  if (raw.sink === undefined || raw.sink === null) missing.push('sink');
  if (raw.kill === undefined || raw.kill === null) missing.push('kill');
  return missing;
}

/**
 * Validate that a raw card carries all three guards (C-19/C-20).
 * Returns the validated Card, or throws MissingGuardError listing what is missing.
 */
export function validateCard(raw: RawCard): Card {
  const missing = missingGuards(raw);
  if (missing.length > 0) {
    throw new MissingGuardError(missing, raw.id);
  }
  return {
    id: raw.id ?? '',
    title: raw.title ?? '',
    status: raw.status ?? 'todo',
    owner: raw.owner as string,
    sink: raw.sink as string,
    kill: raw.kill as number,
    attempts: raw.attempts ?? 0,
    source: raw.source ?? '',
    created: raw.created ?? '',
    action: raw.action,
    doneWhen: raw.doneWhen,
    notes: raw.notes,
  };
}

/** Best-effort blocked card for a raw card that failed guard validation. */
function blockedCardFromRaw(raw: RawCard): Card {
  return {
    id: raw.id ?? '',
    title: raw.title ?? '',
    status: 'blocked',
    owner: (raw.owner as string) ?? '',
    sink: (raw.sink as string) ?? '',
    kill: (raw.kill as number) ?? 0,
    attempts: raw.attempts ?? 0,
    source: raw.source ?? '',
    created: raw.created ?? '',
    action: raw.action,
    doneWhen: raw.doneWhen,
    notes: raw.notes,
  };
}

/**
 * Poller-facing guard gate (C-20/C-33). If the card is missing a guard, return a
 * blocked card (status:'blocked') rather than running it. If attempts have reached
 * kill, also block + signal escalation.
 */
export function gateCard(raw: RawCard): { card: Card; blocked: boolean; reason?: string } {
  try {
    const card = validateCard(raw);
    if (card.attempts >= card.kill) {
      return {
        card: { ...card, status: 'blocked' },
        blocked: true,
        reason: 'attempts >= kill',
      };
    }
    return { card, blocked: false };
  } catch (e) {
    if (e instanceof MissingGuardError) {
      return {
        card: blockedCardFromRaw(raw),
        blocked: true,
        reason: `missing guard(s): ${e.missing.join(', ')}`,
      };
    }
    throw e;
  }
}

/** Minimal read/claim/mark-done interface over a set of in-memory/file-backed cards (C-19). */
export interface Queue {
  read(): Card[];
  /** Claim the next runnable todo card (guards present, status -> doing, attempts += 1). */
  claim(): Card | null;
  markDone(id: string): void;
  block(id: string, reason: string): void;
}

/** Construct a thin in-memory queue over the given raw cards (C-19). */
export function createInMemoryQueue(cards: RawCard[]): Queue {
  // Hold mutable state. Each entry is the current best-known Card view of a raw card.
  const state: Card[] = cards.map((raw) => {
    const gated = gateCard(raw);
    return gated.card;
  });

  function read(): Card[] {
    return state.map((c) => ({ ...c }));
  }

  function claim(): Card | null {
    // Re-gate every card so guard-missing cards become blocked in state.
    for (let i = 0; i < cards.length; i++) {
      const gated = gateCard(cards[i]);
      if (gated.blocked) {
        state[i] = { ...state[i], status: 'blocked', notes: gated.reason ?? state[i].notes };
      }
    }
    // Find the first runnable todo card: validates, status 'todo', attempts < kill.
    for (let i = 0; i < state.length; i++) {
      const c = state[i];
      if (c.status === 'todo' && c.attempts < c.kill) {
        const claimed: Card = { ...c, status: 'doing', attempts: c.attempts + 1 };
        state[i] = claimed;
        return { ...claimed };
      }
    }
    return null;
  }

  function markDone(id: string): void {
    const idx = state.findIndex((c) => c.id === id);
    if (idx >= 0) {
      state[idx] = { ...state[idx], status: 'done' };
    }
  }

  function block(id: string, reason: string): void {
    const idx = state.findIndex((c) => c.id === id);
    if (idx >= 0) {
      state[idx] = { ...state[idx], status: 'blocked', notes: reason };
    }
  }

  return { read, claim, markDone, block };
}

// Matrix inter-agent routing lane — result return library
// (docs/ROUTING.md §"Return semantics").
//
// On success an executor writes `## Result`, sets status=done, and delivers the
// result per the card's `sink`:
//   - lane:return  (default, agent -> agent): write a result card into results/
//                  addressed owner=<requester>. The requester drains its return
//                  lane with the SAME claim() mechanism in reverse.
//   - telegram:<chatId>: push the result to a chat via an injectable sender
//                  (the transport is stubbed/injected so tests never hit network).
//   - card:result: leave the result inline on the original card (status=done);
//                  the requester polls cards where requester == self.
//
// All three are pure functions over the filesystem + an injectable sender, so the
// whole return path is testable with no network and no real Telegram token.

import { join } from 'node:path';
import { isoDate, laneDirs, nextCardId, scanCardIds, writeCardFile, type Card } from './card.js';

/** Pluggable Telegram transport. Injected so tests can assert calls offline. */
export type TelegramSender = (chatId: string, text: string) => Promise<void> | void;

export interface ReturnOptions {
  /** Clock for the result card's created/timestamps. Defaults to new Date(). */
  now?: () => Date;
  /** Telegram transport, required only when a card uses a telegram:<id> sink. */
  telegram?: TelegramSender;
}

/** Outcome of returning one card's result. */
export interface ReturnOutcome {
  mode: 'lane:return' | 'telegram' | 'card:result';
  /** For lane:return, the path of the result card written to results/. */
  resultCardPath?: string;
  /** For lane:return, the id of the result card. */
  resultCardId?: string;
  /** For telegram, the chatId the result was sent to. */
  chatId?: string;
}

/** Parse a sink string into a discriminated mode. */
function parseSink(sink: string): {
  mode: ReturnOutcome['mode'];
  chatId?: string;
} {
  if (sink === 'lane:return') return { mode: 'lane:return' };
  if (sink === 'card:result') return { mode: 'card:result' };
  if (sink.startsWith('telegram:')) {
    return { mode: 'telegram', chatId: sink.slice('telegram:'.length) };
  }
  throw new Error(`unknown sink mode: ${sink}`);
}

/**
 * Deliver the result of a completed executor card. The caller passes the card
 * already populated with its `result` text; this function sets status=done and
 * routes per `sink`. The original (claimed) card on disk is updated to status=done
 * with the result inline in every mode, so there is always a durable record.
 *
 * @param queueRoot the queue root containing tasks/ + results/
 * @param card the completed card (status will be forced to done)
 * @param result the executor's structured result text
 * @param originalPath path of the card on disk (claimed/ file) to mark done
 */
export async function returnResult(
  queueRoot: string,
  card: Card,
  result: string,
  originalPath: string,
  opts: ReturnOptions = {},
): Promise<ReturnOutcome> {
  const now = opts.now ?? (() => new Date());
  const { mode, chatId } = parseSink(card.sink);

  // In every mode the original card is finalized: result inline, status=done.
  const doneCard: Card = { ...card, status: 'done', result };
  writeCardFile(originalPath, doneCard);

  if (mode === 'card:result') {
    return { mode: 'card:result' };
  }

  if (mode === 'telegram') {
    if (!opts.telegram) {
      throw new Error('telegram sink requires an injected sender (opts.telegram)');
    }
    await opts.telegram(chatId!, `[${card.id}] ${card.title}\n\n${result}`);
    return { mode: 'telegram', chatId };
  }

  // lane:return — write a result card addressed to the requester.
  const { results } = laneDirs(queueRoot);
  const ts = now();
  const resultId = nextResultId(queueRoot, ts);
  const resultCard: Card = {
    id: resultId,
    lane: 'result',
    title: `result: ${card.title}`,
    status: 'todo', // the requester will claim() it from its return lane
    owner: card.requester, // flip: the requester now owns the return card
    requester: card.owner, // provenance: who produced the result
    sink: 'card:result', // a result card is itself terminal once claimed
    kill: card.kill,
    priority: card.priority,
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    lease_ms: card.lease_ms,
    depends_on: [],
    created: isoDate(ts),
    source: `result-of:${card.id}`,
    action: `Consume the result of ${card.id}.`,
    doneWhen: `Requester ${card.requester} has read the result.`,
    result,
    notes: `returned by ${card.owner} for request ${card.id}`,
  };
  const resultCardPath = join(results, `${resultId}.md`);
  writeCardFile(resultCardPath, resultCard);

  return { mode: 'lane:return', resultCardPath, resultCardId: resultId };
}

/** Next result-card id, scanned across the lane so ids never collide. */
function nextResultId(queueRoot: string, now: Date): string {
  const { tasks, claimed, results } = laneDirs(queueRoot);
  const ids = scanCardIds([tasks, claimed, results]);
  return nextCardId(ids, now);
}

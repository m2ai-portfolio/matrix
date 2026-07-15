// Soundwave Phase 3 — data loaders for the interest predictor (card Q-20260706-0004).
// Reads the labeled Soundwave grades (verdict + embedding) from the warehouse, and the ungraded
// discovered articles (from seen.json minus me2me-feedback.json) that the ranker scores.

import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { EMBED_MODEL } from '../db/vec.js';
import type { Labeled, Verdict } from './predictor.js';

const FEEDBACK_PATH = `${homedir()}/notes/me2me-feedback.json`;
const SEEN_PATH = `${homedir()}/.claude/soundwave-discover/seen.json`;

export interface LabeledRow extends Labeled {
  title: string;
  notes: string;
}

/** Decode a stored embedding BLOB into a Float32Array (defensive copy — never a view into a reused buffer). */
export function decodeVec(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * Every Soundwave grade that is USABLE as a label: has an up/down verdict AND a canonical embedding.
 * This is the training/eval set. `meta` carries the verdict, domain, and notes the connector stored.
 */
export function loadLabeledSoundwave(db: Database): LabeledRow[] {
  const rows = db
    .prepare(
      `SELECT t.turn_id AS turn_id, t.content AS content, t.meta AS meta, e.vector AS vector
         FROM conversation_turn t
         JOIN embedding e ON e.turn_id = t.turn_id AND e.model = ?
        WHERE t.source = 'soundwave' AND json_extract(t.meta, '$.verdict') IN ('up','down')`,
    )
    .all(EMBED_MODEL) as Array<{ turn_id: string; content: string; meta: string; vector: Buffer }>;

  return rows.map((r) => {
    const meta = JSON.parse(r.meta) as { verdict: Verdict; domain?: string; notes?: string };
    return {
      turn_id: r.turn_id,
      verdict: meta.verdict,
      domain: meta.domain ?? '',
      vec: decodeVec(r.vector),
      title: r.content.split('\n')[0].slice(0, 140),
      notes: meta.notes ?? '',
    };
  });
}

export interface UngradedItem {
  id: string;
  title: string;
  url: string;
  domain: string;
}

/**
 * Discovered articles the owner has NOT graded yet: present in seen.json, absent from
 * me2me-feedback.json, and carrying a url (needed to fetch + embed for ranking). This is the
 * ranker's input — the flywheel question "of what I haven't judged, what would I upvote?".
 */
export function loadUngradedDiscoveries(
  feedbackPath = FEEDBACK_PATH,
  seenPath = SEEN_PATH,
): UngradedItem[] {
  const fb = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as Record<string, unknown>;
  const seen = JSON.parse(readFileSync(seenPath, 'utf-8')) as Record<
    string,
    { url?: string; title?: string; source?: string }
  >;
  const graded = new Set(Object.keys(fb));
  const out: UngradedItem[] = [];
  for (const [id, e] of Object.entries(seen)) {
    if (graded.has(id) || !e.url) continue;
    out.push({ id, title: e.title ?? '', url: e.url, domain: e.source ?? '' });
  }
  return out;
}

// Matrix inter-agent routing lane — task-card (de)serializer (docs/ROUTING.md).
//
// A routing card is a `.md` file with a YAML-ish front-matter block followed by
// four prose sections (Action / Done when / Result / Notes). The `T-` id prefix
// distinguishes routing cards from `Q-` ingest cards. Per
// ~/.claude/rules/loop-and-queue-convention.md every card MUST carry the three
// guards (owner / sink / kill); a parser treats a card missing any of them as
// structurally invalid and refuses to run it.
//
// This serializer is NEW to Matrix. The Q- card writer it conceptually mirrors
// lives in claudeclaw-os; there is nothing to import here, so the format is
// implemented fresh against the schema in docs/ROUTING.md §"Task card schema".

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Card lifecycle states. `claimed` is a transient on-disk marker; the active
 *  in-flight state is `doing`. `blocked` is terminal-until-human (kill reached). */
export type CardStatus = 'todo' | 'claimed' | 'doing' | 'done' | 'blocked';

/** The four guard-bearing front-matter fields plus routing metadata. */
export interface CardFrontMatter {
  /** Stable id: T-YYYYMMDD-NNNN, same-day sequence (see nextCardId). */
  id: string;
  lane: string;
  title: string;
  status: CardStatus;
  /** GUARD 1 — the agent that must EXECUTE this card (not the drainer). */
  owner: string;
  /** Who asked; drives the return path. */
  requester: string;
  /** GUARD 2 — where the result lands (lane:return | telegram:<id> | card:result). */
  sink: string;
  /** GUARD 3 — max attempts; on reaching it the card is blocked + escalated. */
  kill: number;
  /** Higher = sooner. */
  priority: number;
  attempts: number;
  /** Lease holder id, set atomically on claim; null when unclaimed. */
  claimed_by: string | null;
  /** Lease start (epoch ms) for stale-claim recovery; null when unclaimed. */
  claimed_at: number | null;
  /** Expired lease (claimed_at + lease_ms < now) => the card is reclaimable. */
  lease_ms: number;
  /** Other T- ids that must be `done` before this card is claimable. */
  depends_on: string[];
  /** YYYY-MM-DD. */
  created: string;
  /** Provenance: claudeclaw | external:<vendor> | a result-return tag. */
  source: string;
}

/** A fully parsed card: guards + the four prose sections. */
export interface Card extends CardFrontMatter {
  action: string;
  doneWhen: string;
  result: string;
  notes: string;
}

/** The three guard field names enforced by the No Orphan Loops convention. */
export const GUARD_FIELDS = ['owner', 'sink', 'kill'] as const;

const SECTION_KEYS = {
  Action: 'action',
  'Done when': 'doneWhen',
  Result: 'result',
  Notes: 'notes',
} as const;

/** Thrown when a card is missing a guard or a required field, or is malformed. */
export class CardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardValidationError';
  }
}

/** True when `value` is a non-empty, non-placeholder guard value. Mirrors the
 *  no-orphan-loops hook: empty / none / tbd / "-" all count as MISSING. */
function isRealGuardValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '' && s !== 'none' && s !== 'tbd' && s !== '-' && s !== 'null';
}

/** Throw unless all three guards (owner, sink, kill) carry real values. */
export function assertGuards(fm: Partial<CardFrontMatter>): void {
  const missing: string[] = [];
  if (!isRealGuardValue(fm.owner)) missing.push('owner');
  if (!isRealGuardValue(fm.sink)) missing.push('sink');
  // kill is a number > 0; 0 / NaN / missing all fail.
  if (
    fm.kill === undefined ||
    fm.kill === null ||
    !Number.isFinite(fm.kill) ||
    (fm.kill as number) <= 0
  ) {
    missing.push('kill');
  }
  if (missing.length > 0) {
    throw new CardValidationError(
      `card is missing required guard(s): ${missing.join(', ')} (owner/sink/kill must have real values)`,
    );
  }
}

function serializeScalar(value: unknown): string {
  if (value === null) return 'null';
  return String(value);
}

function serializeDependsOn(ids: string[]): string {
  if (ids.length === 0) return '[]';
  return `[${ids.join(', ')}]`;
}

function parseDependsOn(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Serialize a card to its on-disk `.md` text. Guards are asserted first so an
 * invalid card can never be written.
 */
export function serializeCard(card: Card): string {
  assertGuards(card);

  const fm = [
    '---',
    `id: ${card.id}`,
    `lane: ${card.lane}`,
    `title: ${card.title}`,
    `status: ${card.status}`,
    `owner: ${card.owner}`,
    `requester: ${card.requester}`,
    `sink: ${card.sink}`,
    `kill: ${card.kill}`,
    `attempts: ${card.attempts}`,
    `priority: ${card.priority}`,
    `claimed_by: ${serializeScalar(card.claimed_by)}`,
    `claimed_at: ${serializeScalar(card.claimed_at)}`,
    `lease_ms: ${card.lease_ms}`,
    `depends_on: ${serializeDependsOn(card.depends_on)}`,
    `created: ${card.created}`,
    `source: ${card.source}`,
    '---',
  ].join('\n');

  const body = [
    '',
    '## Action',
    card.action.trim(),
    '',
    '## Done when',
    card.doneWhen.trim(),
    '',
    '## Result',
    card.result.trim(),
    '',
    '## Notes',
    card.notes.trim(),
    '',
  ].join('\n');

  return `${fm}\n${body}`;
}

function coerceScalar(key: string, raw: string): string | number | null | string[] {
  const value = raw.trim();
  if (key === 'depends_on') return parseDependsOn(value);
  if (value === 'null') return null;
  if (
    key === 'kill' ||
    key === 'attempts' ||
    key === 'priority' ||
    key === 'lease_ms' ||
    key === 'claimed_at'
  ) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

/**
 * Parse on-disk `.md` text back into a Card. Validates the front-matter block,
 * the four required sections, and the three guards. Round-trips losslessly with
 * serializeCard for well-formed input.
 */
export function parseCard(text: string): Card {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new CardValidationError('card has no valid front-matter block');
  }
  const [, fmBlock, bodyBlock] = fmMatch;

  const fm: Record<string, unknown> = {};
  for (const line of fmBlock.split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new CardValidationError(`malformed front-matter line: ${line}`);
    }
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1);
    fm[key] = coerceScalar(key, raw);
  }

  // Parse the prose sections by "## <Heading>".
  const sections: Record<string, string> = {
    action: '',
    doneWhen: '',
    result: '',
    notes: '',
  };
  const sectionRegex = /^##\s+(.+)$/;
  let current: string | null = null;
  const buffer: string[] = [];
  const flush = () => {
    if (current && current in sections) {
      sections[current] = buffer.join('\n').trim();
    }
    buffer.length = 0;
  };
  for (const line of bodyBlock.split('\n')) {
    const m = line.match(sectionRegex);
    if (m) {
      flush();
      const heading = m[1].trim() as keyof typeof SECTION_KEYS;
      current = SECTION_KEYS[heading] ?? null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  const requiredFields = [
    'id',
    'lane',
    'title',
    'status',
    'owner',
    'requester',
    'sink',
    'kill',
    'priority',
    'attempts',
    'lease_ms',
    'created',
    'source',
  ];
  for (const field of requiredFields) {
    if (!(field in fm)) {
      throw new CardValidationError(`card front-matter missing required field: ${field}`);
    }
  }

  assertGuards(fm as Partial<CardFrontMatter>);

  const card: Card = {
    id: String(fm.id),
    lane: String(fm.lane),
    title: String(fm.title),
    status: String(fm.status) as CardStatus,
    owner: String(fm.owner),
    requester: String(fm.requester),
    sink: String(fm.sink),
    kill: fm.kill as number,
    priority: fm.priority as number,
    attempts: fm.attempts as number,
    claimed_by:
      fm.claimed_by === null || fm.claimed_by === undefined ? null : String(fm.claimed_by),
    claimed_at:
      fm.claimed_at === null || fm.claimed_at === undefined ? null : (fm.claimed_at as number),
    lease_ms: fm.lease_ms as number,
    depends_on: (fm.depends_on as string[] | undefined) ?? [],
    created: String(fm.created),
    source: String(fm.source),
    action: sections.action,
    doneWhen: sections.doneWhen,
    result: sections.result,
    notes: sections.notes,
  };
  return card;
}

/** Two-digit-month / -day zero-pad. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a Date as YYYYMMDD for the T- id, in local time. */
export function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** Format a Date as YYYY-MM-DD for the `created` field. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Compute the next T- id for a given day by scanning existing card ids for that
 * day's stamp and incrementing the max sequence. Same-day cards get
 * monotonically increasing NNNN; a new day restarts at 0001.
 *
 * @param existingIds all card ids currently known (across tasks/, claimed/, results/)
 * @param now the clock (defaults to new Date())
 */
export function nextCardId(existingIds: string[], now: Date = new Date()): string {
  const stamp = dateStamp(now);
  const prefix = `T-${stamp}-`;
  let max = 0;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const seq = Number(id.slice(prefix.length));
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/**
 * Scan one or more queue directories for `T-*.md` files and return every card
 * id found (the bare T-YYYYMMDD-NNNN, stripped of any `.<agentId>` claim suffix).
 * Used to feed nextCardId so same-day sequencing accounts for claimed/done cards.
 */
export function scanCardIds(dirs: string[]): string[] {
  const ids = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('T-') || !name.endsWith('.md')) continue;
      // strip ".md" then any ".<agentId>" claim suffix: T-20260615-0001.galvatron.md
      const base = name.slice(0, -3);
      const m = base.match(/^(T-\d{8}-\d{4})/);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids];
}

/** Write a card to `path`, creating the parent directory if needed. */
export function writeCardFile(path: string, card: Card): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, serializeCard(card), 'utf8');
}

/** Read and parse a card file from `path`. */
export function readCardFile(path: string): Card {
  return parseCard(readFileSync(path, 'utf8'));
}

/**
 * Build a fresh todo card with sane defaults, asserting guards. Convenience for
 * producers (requesters) dropping a new T- card into tasks/.
 */
export function makeCard(input: {
  id: string;
  title: string;
  owner: string;
  requester: string;
  action: string;
  doneWhen: string;
  sink?: string;
  kill?: number;
  priority?: number;
  lease_ms?: number;
  depends_on?: string[];
  source?: string;
  lane?: string;
  now?: Date;
}): Card {
  const now = input.now ?? new Date();
  const card: Card = {
    id: input.id,
    lane: input.lane ?? 'task',
    title: input.title,
    status: 'todo',
    owner: input.owner,
    requester: input.requester,
    sink: input.sink ?? 'lane:return',
    kill: input.kill ?? 3,
    priority: input.priority ?? 5,
    attempts: 0,
    claimed_by: null,
    claimed_at: null,
    lease_ms: input.lease_ms ?? 300_000,
    depends_on: input.depends_on ?? [],
    created: isoDate(now),
    source: input.source ?? 'claudeclaw',
    action: input.action,
    doneWhen: input.doneWhen,
    result: '',
    notes: '',
  };
  assertGuards(card);
  return card;
}

/** Standard lane directory layout under a queue root. */
export interface LaneDirs {
  tasks: string;
  claimed: string;
  results: string;
}

/** Resolve the three routing lane dirs under a queue root. */
export function laneDirs(queueRoot: string): LaneDirs {
  return {
    tasks: join(queueRoot, 'tasks'),
    claimed: join(queueRoot, 'tasks', 'claimed'),
    results: join(queueRoot, 'results'),
  };
}

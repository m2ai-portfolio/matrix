// Matrix Phase 0 — Claude Code transcript connector.
// Builder implementation. Spec claims:
//   C-08,C-09,C-11,C-12,C-13,C-14,C-15,C-16,C-17,C-18,C-22,C-24,C-26..C-31.
// READ-ONLY over ~/.claude/projects/*/*.jsonl source transcripts (C-22).

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { applySchema } from '../db/schema.js';

/** A normalized warehouse turn ready for INSERT into conversation_turn (C-03/C-17). */
export interface NormalizedTurn {
  turn_id: string; // content hash (C-08)
  source: string; // 'claude_code' (C-17)
  source_id: string; // line uuid (C-17)
  ingestion_batch_id: string | null; // lineage; NOT part of the hash input (C-30)
  conversation_id: string; // sessionId (C-17)
  ts: string; // line timestamp (C-17)
  role: string; // message.role (C-17)
  content: string; // extracted human-readable text (C-14/C-15/C-26)
  tokens: number | null;
  project: string; // dir name under ~/.claude/projects/ (C-17)
  meta: string; // JSON string of lineage extras: cwd, gitBranch, ... (C-31)
}

/** Result counts from an ingest pass (C-18). */
export interface IngestResult {
  inserted: number; // rows actually inserted (new turn_ids)
  seen: number; // turn-type lines processed
  skipped: number; // non-turn / non-text / malformed lines skipped (C-13/C-16/C-24)
}

/**
 * Enumerate Claude Code transcript files: glob ~/.claude/projects/*\/*.jsonl (C-11).
 * Read-only (C-22). `root` overridable for tests so the real files are never read.
 * Returns absolute paths ending in .jsonl. Never throws if root does not exist.
 */
export function enumerateTranscripts(root?: string): string[] {
  const base = root ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    const subdir = join(base, entry);
    let isDir = false;
    try {
      isDir = statSync(subdir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    for (const file of readdirSync(subdir)) {
      if (file.endsWith('.jsonl')) {
        out.push(join(subdir, file));
      }
    }
  }
  return out;
}

interface ContentBlock {
  type?: string;
  text?: unknown;
  content?: unknown;
}

/**
 * Extract human-readable text from a message.content value (C-14/C-15/C-16/C-26/C-29).
 * - string content -> used directly
 * - list content -> concatenation (in order) of ALL `text` block text fields (C-26);
 *   for user turns, also appends string `content` of `tool_result` blocks (C-14)
 * - null / not array/string / no extractable text -> returns '' (C-16/C-29)
 */
export function extractText(role: string, content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined || !Array.isArray(content)) return '';

  let out = '';
  for (const raw of content as ContentBlock[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw;
    if (block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    } else if (
      role === 'user' &&
      block.type === 'tool_result' &&
      typeof block.content === 'string'
    ) {
      out += block.content;
    }
  }
  return out;
}

/**
 * Deterministic content hash for a turn's STABLE identity (C-08/C-30).
 * Hashes EXACTLY the 5 identity fields; excludes batch id, timestamps, and any clock/random.
 */
export function turnId(turn: {
  source: string;
  source_id: string;
  conversation_id: string;
  role: string;
  content: string;
}): string {
  const serialized = JSON.stringify({
    source: turn.source,
    source_id: turn.source_id,
    conversation_id: turn.conversation_id,
    role: turn.role,
    content: turn.content,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

interface RawLineMessage {
  role?: string;
  content?: unknown;
}

interface RawLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
  cwd?: string;
  gitBranch?: string;
  message?: RawLineMessage | null;
}

/**
 * Normalize one raw JSONL line (already a string) into a NormalizedTurn, or null to skip.
 * Skip rules: empty (C-27), malformed JSON (C-24), non-turn type (C-13),
 * missing message (C-28), null content (C-29), no extractable text (C-16).
 * `project` is the transcript's project dir name; `batchId` is lineage only (not hashed).
 */
export function parseLine(
  rawLine: string,
  project: string,
  batchId: string | null,
): NormalizedTurn | null {
  const trimmed = rawLine.trim();
  if (trimmed === '') return null; // C-27

  let obj: RawLine;
  try {
    obj = JSON.parse(trimmed) as RawLine;
  } catch {
    return null; // C-24
  }

  if (obj === null || typeof obj !== 'object') return null;
  if (obj.type !== 'user' && obj.type !== 'assistant') return null; // C-13
  if (obj.message === undefined || obj.message === null) return null; // C-28

  const content = obj.message.content;
  if (content === undefined || content === null) return null; // C-29

  const role = obj.message.role ?? '';
  const text = extractText(role, content);
  if (text === '') return null; // C-16

  const source = 'claude_code';
  const source_id = obj.uuid ?? '';
  const conversation_id = obj.sessionId ?? '';

  const turn: NormalizedTurn = {
    turn_id: turnId({ source, source_id, conversation_id, role, content: text }),
    source,
    source_id,
    ingestion_batch_id: batchId,
    conversation_id,
    ts: obj.timestamp ?? '',
    role,
    content: text,
    tokens: null,
    project,
    meta: JSON.stringify({ cwd: obj.cwd, gitBranch: obj.gitBranch }),
  };
  return turn;
}

/**
 * INSERT OR IGNORE a normalized turn on the content-hash PK (C-12). Returns true if a
 * new row was inserted, false if it already existed (idempotent re-insert).
 */
export function insertTurn(db: Database.Database, turn: NormalizedTurn): boolean {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id,
        ts, role, content, tokens, project, meta)
     VALUES
       (@turn_id, @source, @source_id, @ingestion_batch_id, @conversation_id,
        @ts, @role, @content, @tokens, @project, @meta)`,
  );
  const result = stmt.run(turn);
  return result.changes === 1;
}

/**
 * Ingest: walk transcript files, parse + dedupe-insert each turn, return counts (C-18).
 * KEYSTONE (C-09): running this twice over the same input inserts ZERO new rows the 2nd pass.
 *
 * @param db    an already-open DB (tests pass an in-memory/temp DB so the real store is untouched)
 * @param files explicit list of files (tests pass a small fixture file list)
 */
export function ingestFiles(db: Database.Database, files: string[]): IngestResult {
  applySchema(db); // idempotent; ensures tables exist (C-10)

  let inserted = 0;
  let seen = 0;
  let skipped = 0;

  for (const file of files) {
    const project = basename(dirname(file));
    const batchId = file; // lineage only; NOT part of turn_id (C-30)
    const body = readFileSync(file, 'utf8');
    for (const line of body.split('\n')) {
      const turn = parseLine(line, project, batchId);
      if (turn === null) {
        skipped++;
        continue;
      }
      seen++;
      if (insertTurn(db, turn)) {
        inserted++;
      }
    }
  }

  return { inserted, seen, skipped };
}

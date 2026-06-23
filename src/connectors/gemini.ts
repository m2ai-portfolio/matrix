// Matrix Phase 3 — Tier-B Gemini connector.
//
// Handles BOTH Gemini export shapes, auto-detected per file:
//
//   A) "Gemini in Workspace" — one JSON file per conversation (often a .txt
//      extension despite being JSON): { conversation_turns: [ {user_turn:{prompt}},
//      {system_turn:{text:[{data}], model_thoughts}} ], title, creation_time }.
//      Threaded, role-tagged, timestamped, includes the model's answer. (This is
//      the format the owner's real takeout uses — verified 2026-06-21.)
//
//   B) "Gemini Apps" (consumer gemini.google.com) — a flat Google "My Activity"
//      JSON array of records; the model reply is often absent (prompts only).
//
// Both normalize into conversation_turn as source=gemini, reusing the Phase 0
// turnId content-hash (re-run inserts zero rows). NodeNext ESM: .js extensions.

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { applySchema } from '../db/schema.js';
import { turnId } from './claude-code.js';
import { openDb } from '../db/open.js';

const SOURCE = 'gemini';

/** A normalized Gemini turn (pre-hash). */
export interface NormalizedGeminiTurn {
  source_id: string;
  conversation_id: string;
  role: string;
  content: string;
  ts: string;
  meta: string;
}

/** Shared INSERT OR IGNORE of normalized turns; returns the count actually inserted. */
function insertGeminiTurns(
  db: Database.Database,
  turns: NormalizedGeminiTurn[],
  batchId: string,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id,
        ts, role, content, tokens, project, meta)
     VALUES
       (@turn_id, @source, @source_id, @ingestion_batch_id, @conversation_id,
        @ts, @role, @content, @tokens, @project, @meta)`,
  );
  let inserted = 0;
  const run = db.transaction((ts: NormalizedGeminiTurn[]) => {
    for (const t of ts) {
      const tid = turnId({
        source: SOURCE,
        source_id: t.source_id,
        conversation_id: t.conversation_id,
        role: t.role,
        content: t.content,
      });
      const res = stmt.run({
        turn_id: tid,
        source: SOURCE,
        source_id: t.source_id,
        ingestion_batch_id: batchId,
        conversation_id: t.conversation_id,
        ts: t.ts,
        role: t.role,
        content: t.content,
        tokens: null,
        project: '',
        meta: t.meta,
      });
      if (res.changes === 1) inserted++;
    }
  });
  run(turns);
  return inserted;
}

// ===================== Format A: Gemini in Workspace =====================

interface WsTextPart {
  data?: unknown;
}
interface WsUserTurn {
  prompt?: unknown;
  turn_index?: number;
  turn_last_modified?: string;
}
interface WsSystemTurn {
  text?: WsTextPart[];
  model_thoughts?: unknown[];
  turn_index?: number;
  turn_last_modified?: string;
}
interface WsTurn {
  user_turn?: WsUserTurn;
  system_turn?: WsSystemTurn;
}
export interface WorkspaceConversation {
  conversation_turns?: WsTurn[];
  title?: string;
  creation_time?: string;
}

/** True when a parsed object is the Workspace per-conversation shape. */
function isWorkspaceConversation(v: unknown): v is WorkspaceConversation {
  return (
    v !== null &&
    typeof v === 'object' &&
    Array.isArray((v as WorkspaceConversation).conversation_turns)
  );
}

/**
 * Normalize one Workspace conversation into ordered turns. user_turn -> role user
 * (content=prompt); system_turn -> role assistant (content = joined text[].data,
 * the answer; model_thoughts are reasoning and kept only as a meta flag). Empty
 * turns are skipped. `conversationId` is the per-file stable id (the filename stem).
 */
export function normalizeWorkspaceConversation(
  conv: WorkspaceConversation,
  conversationId: string,
): NormalizedGeminiTurn[] {
  const out: NormalizedGeminiTurn[] = [];
  const title = typeof conv.title === 'string' ? conv.title : null;
  const arr = Array.isArray(conv.conversation_turns) ? conv.conversation_turns : [];

  for (const wt of arr) {
    if (wt.user_turn) {
      const prompt = typeof wt.user_turn.prompt === 'string' ? wt.user_turn.prompt.trim() : '';
      if (prompt === '') continue;
      out.push({
        source_id: `${conversationId}:${wt.user_turn.turn_index ?? out.length}:user`,
        conversation_id: conversationId,
        role: 'user',
        content: prompt,
        ts: wt.user_turn.turn_last_modified ?? '',
        meta: JSON.stringify({ title, kind: 'workspace' }),
      });
    } else if (wt.system_turn) {
      const text = Array.isArray(wt.system_turn.text)
        ? wt.system_turn.text
            .map((p) => (typeof p.data === 'string' ? p.data : ''))
            .join('\n\n')
            .trim()
        : '';
      if (text === '') continue;
      out.push({
        source_id: `${conversationId}:${wt.system_turn.turn_index ?? out.length}:model`,
        conversation_id: conversationId,
        role: 'assistant',
        content: text,
        ts: wt.system_turn.turn_last_modified ?? '',
        meta: JSON.stringify({
          title,
          kind: 'workspace',
          has_thoughts:
            Array.isArray(wt.system_turn.model_thoughts) &&
            wt.system_turn.model_thoughts.length > 0,
        }),
      });
    }
  }
  return out;
}

// ===================== Format B: Gemini Apps (My Activity) =====================

const PROMPT_PREFIXES = ['Prompted ', 'Asked ', 'Said '];

interface GeminiRecord {
  header?: string;
  title?: string;
  titleUrl?: string;
  time?: string;
  description?: string;
}

function stripPromptPrefix(title: string): string {
  for (const p of PROMPT_PREFIXES) {
    if (title.startsWith(p)) return title.slice(p.length);
  }
  return title;
}

/** PROVISIONAL My-Activity normalizer (verify against a real Gemini Apps export). */
export function normalizeRecord(rec: GeminiRecord, idx: number): NormalizedGeminiTurn[] {
  if (rec === null || typeof rec !== 'object') return [];
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  if (title === '') return [];

  const ts = typeof rec.time === 'string' ? rec.time : '';
  const conversation_id = typeof rec.titleUrl === 'string' ? rec.titleUrl : '';
  const baseId = `${ts || 'notime'}#${idx}`;
  const meta = JSON.stringify({ header: rec.header ?? null, kind: 'my-activity' });

  const out: NormalizedGeminiTurn[] = [];
  const prompt = stripPromptPrefix(title).trim();
  if (prompt !== '') {
    out.push({
      source_id: `${baseId}:user`,
      conversation_id,
      role: 'user',
      content: prompt,
      ts,
      meta,
    });
  }
  const reply = typeof rec.description === 'string' ? rec.description.trim() : '';
  if (reply !== '') {
    out.push({
      source_id: `${baseId}:model`,
      conversation_id,
      role: 'assistant',
      content: reply,
      ts,
      meta,
    });
  }
  return out;
}

// ===================== Unified ingest =====================

export interface GeminiFileResult {
  file: string;
  format: 'workspace' | 'my-activity';
  produced: number; // turns normalized
  inserted: number; // new rows after dedupe
}

/**
 * Parse one staged Gemini file and ingest it, auto-detecting Workspace vs
 * My-Activity. `batchId` defaults to the file path (lineage only).
 */
export function ingestGeminiFile(db: Database.Database, filePath: string): GeminiFileResult {
  applySchema(db);
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const stem = basename(filePath).replace(/\.(txt|json)$/i, '');

  let turns: NormalizedGeminiTurn[];
  let format: GeminiFileResult['format'];

  if (isWorkspaceConversation(parsed)) {
    format = 'workspace';
    turns = normalizeWorkspaceConversation(parsed, stem);
  } else {
    format = 'my-activity';
    const records: GeminiRecord[] = Array.isArray(parsed)
      ? (parsed as GeminiRecord[])
      : parsed !== null && typeof parsed === 'object'
        ? ((Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v)) ??
            []) as GeminiRecord[])
        : [];
    turns = records.flatMap((r, i) => normalizeRecord(r, i));
  }

  const inserted = insertGeminiTurns(db, turns, filePath);
  return { file: filePath, format, produced: turns.length, inserted };
}

/** Recursively collect staged Gemini files (*.json + *.txt) under store/staging/gemini/. */
export function defaultGeminiExportFiles(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const root = join(repoRoot, 'store', 'staging', 'gemini');
  if (!existsSync(root)) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(json|txt)$/i.test(name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// Auto-run only when invoked directly (node dist/connectors/gemini.js).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const files = arg ? [arg] : defaultGeminiExportFiles();
  if (files.length === 0) {
    console.error(
      'Matrix gemini ingest: no .json/.txt found under store/staging/gemini/.\n' +
        'Gemini in Workspace: takeout -> "Gemini in Workspace/Conversation History/*.txt".\n' +
        'Gemini Apps (consumer): takeout.google.com -> Gemini Apps -> format JSON.\n' +
        'See store/staging/STAGING.md.',
    );
    process.exitCode = 1;
  } else {
    const db = openDb();
    try {
      let totalIn = 0;
      for (const f of files) {
        const r = ingestGeminiFile(db, f);
        console.log(
          `Matrix gemini ingest [${basename(f)}]: format=${r.format} produced=${r.produced} inserted=${r.inserted}`,
        );
        totalIn += r.inserted;
      }
      console.log(`Matrix gemini ingest: ${totalIn} inserted across ${files.length} file(s)`);
      process.exitCode = 0;
    } catch (err: unknown) {
      console.error(
        `Matrix gemini ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}

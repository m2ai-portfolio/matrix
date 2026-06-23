// Matrix Phase 3 — Tier-B claude.ai + Claude Desktop export connector.
//
// Parses a claude.ai data-export `conversations.json` (one export covers both the
// web app and Claude Desktop — they share the account) into conversation_turn as
// source=claude_ai, reusing the Phase 0 content-hash for dedupe. A re-run inserts
// zero rows (INSERT OR IGNORE on the turn_id PK). This is SEPARATE from the
// Claude Code (CLI) transcripts already ingested as source=claude_code.
//
// Shape (verified 2026-06-21): an array of conversations
//   { uuid, name, summary, created_at, updated_at, account, chat_messages: [...] }
// each message
//   { uuid, text, content:[{type,text,...}], sender:'human'|'assistant', created_at, ... }
// Text lives in content[] blocks (type 'text'); the flat `text` field is a fallback.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { applySchema } from '../db/schema.js';
import { turnId } from './claude-code.js';
import { openDb } from '../db/open.js';

const SOURCE = 'claude_ai';

// Map source senders to the cross-source role vocabulary (claude-code uses
// user/assistant), so a "user turns" query works uniformly across every source.
function normalizeRole(sender: unknown): string {
  if (sender === 'human') return 'user';
  if (typeof sender === 'string' && sender) return sender;
  return '';
}

interface ContentBlock {
  type?: string;
  text?: unknown;
}
interface ChatMessage {
  uuid?: string;
  text?: unknown;
  content?: ContentBlock[];
  sender?: string;
  created_at?: string;
}
export interface ClaudeConversation {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  chat_messages?: ChatMessage[];
}

export interface ClaudeIngestResult {
  conversations: number;
  seen: number; // messages that normalized to a turn
  inserted: number; // new rows (deduped)
  skipped: number; // messages with no extractable text
}

export interface NormalizedClaudeTurn {
  source_id: string;
  conversation_id: string;
  role: string;
  content: string;
  ts: string;
  meta: string;
}

/**
 * Extract text from a message: concatenate the text of every `content` block of
 * type 'text' (in order); fall back to the flat `text` field. Other block types
 * (tool_use / tool_result / thinking) carry no human-conversation text and are
 * skipped — matching the corpus posture of the claude-code connector.
 */
export function extractClaudeText(content: unknown, fallbackText: unknown): string {
  if (Array.isArray(content)) {
    let out = '';
    for (const b of content) {
      if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        out += b.text;
      }
    }
    if (out.trim() !== '') return out;
  }
  if (typeof fallbackText === 'string') return fallbackText;
  return '';
}

/** Map one chat message to a normalized turn, or null to skip (no text). */
export function normalizeMessage(
  msg: ChatMessage,
  conv: ClaudeConversation,
): NormalizedClaudeTurn | null {
  if (msg === null || typeof msg !== 'object') return null;
  const content = extractClaudeText(msg.content, msg.text);
  if (content.trim() === '') return null;

  const role = normalizeRole(msg.sender);
  if (role === '') return null;

  return {
    source_id: typeof msg.uuid === 'string' ? msg.uuid : '',
    conversation_id: typeof conv.uuid === 'string' ? conv.uuid : '',
    role,
    content,
    ts: typeof msg.created_at === 'string' ? msg.created_at : '',
    meta: JSON.stringify({
      name: conv.name ?? null,
      summary: conv.summary ?? null,
    }),
  };
}

/**
 * Ingest an array of claude.ai conversations into the warehouse. Reuses Phase 0
 * turnId() for content-hash dedupe; INSERT OR IGNORE gives idempotency.
 */
export function ingestClaudeConversations(
  db: Database.Database,
  conversations: ClaudeConversation[],
  batchId = 'claude-ai-export',
): ClaudeIngestResult {
  applySchema(db);

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id,
        ts, role, content, tokens, project, meta)
     VALUES
       (@turn_id, @source, @source_id, @ingestion_batch_id, @conversation_id,
        @ts, @role, @content, @tokens, @project, @meta)`,
  );

  let inserted = 0;
  let seen = 0;
  let skipped = 0;

  const run = db.transaction((convs: ClaudeConversation[]) => {
    for (const conv of convs) {
      const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
      for (const msg of messages) {
        const t = normalizeMessage(msg, conv);
        if (t === null) {
          skipped++;
          continue;
        }
        seen++;
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
    }
  });
  run(conversations);

  return { conversations: conversations.length, seen, inserted, skipped };
}

/** Parse a staged conversations.json and ingest it. */
export function ingestClaudeExport(db: Database.Database, filePath: string): ClaudeIngestResult {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('claude conversations.json is not an array');
  }
  return ingestClaudeConversations(db, parsed as ClaudeConversation[], filePath);
}

// ===================== Extras: memories.json + design_chats/ =====================

/** Shared INSERT OR IGNORE for the memory/design paths (conversations path inlines its own). */
function insertClaudeTurns(
  db: Database.Database,
  turns: NormalizedClaudeTurn[],
  batchId: string,
): number {
  applySchema(db);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id,
        ts, role, content, tokens, project, meta)
     VALUES
       (@turn_id, @source, @source_id, @ingestion_batch_id, @conversation_id,
        @ts, @role, @content, @tokens, @project, @meta)`,
  );
  let inserted = 0;
  const run = db.transaction((ts: NormalizedClaudeTurn[]) => {
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

interface ClaudeMemoriesRecord {
  conversations_memory?: unknown;
  project_memories?: Record<string, unknown>;
}

/**
 * memories.json holds Claude's synthesized memory: one `conversations_memory`
 * markdown blob + a `project_memories` map (project-uuid -> markdown). Each becomes
 * a role='memory' turn. Empty values are skipped.
 */
export function toMemoryTurns(rec: ClaudeMemoriesRecord): NormalizedClaudeTurn[] {
  const out: NormalizedClaudeTurn[] = [];
  if (typeof rec.conversations_memory === 'string' && rec.conversations_memory.trim() !== '') {
    out.push({
      source_id: 'memories:conversations',
      conversation_id: 'memories',
      role: 'memory',
      content: rec.conversations_memory,
      ts: '',
      meta: JSON.stringify({ kind: 'conversations_memory' }),
    });
  }
  const pm = rec.project_memories;
  if (pm !== null && typeof pm === 'object') {
    for (const [uuid, val] of Object.entries(pm)) {
      if (typeof val === 'string' && val.trim() !== '') {
        out.push({
          source_id: `memories:project:${uuid}`,
          conversation_id: 'memories:project',
          role: 'memory',
          content: val,
          ts: '',
          meta: JSON.stringify({ kind: 'project_memory', project_uuid: uuid }),
        });
      }
    }
  }
  return out;
}

/** Ingest memories.json. Accepts the canonical `[ {conversations_memory,...} ]` array or a bare object. */
export function ingestClaudeMemories(db: Database.Database, filePath: string): number {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const rec = (Array.isArray(parsed) ? parsed[0] : parsed) as ClaudeMemoriesRecord | undefined;
  if (rec === undefined || rec === null || typeof rec !== 'object') return 0;
  return insertClaudeTurns(db, toMemoryTurns(rec), filePath);
}

interface DesignMessage {
  uuid?: string;
  role?: string;
  content?: unknown;
  created_at?: string;
}
export interface DesignChat {
  uuid?: string;
  title?: string;
  project?: string;
  messages?: DesignMessage[];
}

/**
 * Extract text from a design-chat message's `content`. The real shape nests one
 * level: content is an OBJECT `{ role, content: <string>, attachments:[{content}] }`
 * (the user's first turn often carries its body in an attachment, not content).
 * Falls back to a plain string or a content-block array defensively.
 */
function extractDesignContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return extractClaudeText(raw, '');
  if (raw !== null && typeof raw === 'object') {
    const o = raw as { content?: unknown; attachments?: Array<{ content?: unknown }> };
    let out = typeof o.content === 'string' ? o.content : '';
    if (Array.isArray(o.attachments)) {
      for (const a of o.attachments) {
        if (
          a !== null &&
          typeof a === 'object' &&
          typeof a.content === 'string' &&
          a.content.trim() !== ''
        ) {
          out += (out === '' ? '' : '\n\n') + a.content;
        }
      }
    }
    return out;
  }
  return '';
}

/**
 * A design-chat file is a single conversation with `messages` (not chat_messages),
 * each `{uuid, role:'user'|'assistant', content, created_at}` where content nests the
 * text (see extractDesignContent). Empty messages are skipped.
 */
export function toDesignTurns(chat: DesignChat): NormalizedClaudeTurn[] {
  const out: NormalizedClaudeTurn[] = [];
  const msgs = Array.isArray(chat.messages) ? chat.messages : [];
  for (const m of msgs) {
    const content = extractDesignContent(m.content);
    if (content.trim() === '') continue;
    const role = normalizeRole(m.role);
    if (role === '') continue;
    out.push({
      source_id: typeof m.uuid === 'string' ? m.uuid : '',
      conversation_id: typeof chat.uuid === 'string' ? chat.uuid : '',
      role,
      content,
      ts: typeof m.created_at === 'string' ? m.created_at : '',
      meta: JSON.stringify({
        name: chat.title ?? null,
        kind: 'design_chat',
        project: chat.project ?? null,
      }),
    });
  }
  return out;
}

/** Ingest every *.json design chat in a directory. */
export function ingestClaudeDesignChatsDir(db: Database.Database, dir: string): number {
  if (!existsSync(dir)) return 0;
  let inserted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const p = join(dir, f);
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    const chat = (Array.isArray(parsed) ? parsed[0] : parsed) as DesignChat;
    inserted += insertClaudeTurns(db, toDesignTurns(chat), p);
  }
  return inserted;
}

export interface ClaudeStagingResult {
  conversations: number;
  convInserted: number;
  memInserted: number;
  designInserted: number;
}

/**
 * Ingest the full claude.ai export staged under store/staging/claude/ (or baseDir):
 * conversations.json + memories.json + design_chats/, each if present. Files may sit
 * at the dir root or under extracted/. Idempotent.
 */
export function ingestClaudeStaging(db: Database.Database, baseDir?: string): ClaudeStagingResult {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const root = baseDir ?? join(repoRoot, 'store', 'staging', 'claude');
  const pick = (rel: string): string | undefined =>
    [join(root, 'extracted', rel), join(root, rel)].find((p) => existsSync(p));

  const convPath = pick('conversations.json');
  const memPath = pick('memories.json');
  const designDir = pick('design_chats');

  let conversations = 0;
  let convInserted = 0;
  if (convPath) {
    const r = ingestClaudeExport(db, convPath);
    conversations = r.conversations;
    convInserted = r.inserted;
  }
  const memInserted = memPath ? ingestClaudeMemories(db, memPath) : 0;
  const designInserted = designDir ? ingestClaudeDesignChatsDir(db, designDir) : 0;
  return { conversations, convInserted, memInserted, designInserted };
}

/** First existing staged conversations.json (extracted/ then the dir root). */
export function defaultClaudeExportPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  const base = join(repoRoot, 'store', 'staging', 'claude');
  const candidates = [
    join(base, 'extracted', 'conversations.json'),
    join(base, 'conversations.json'),
  ];
  return candidates.find((p) => existsSync(p));
}

// Auto-run only when invoked directly (node dist/connectors/claude-ai.js).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (!defaultClaudeExportPath()) {
    console.error(
      'Matrix claude-ai ingest: conversations.json not found under store/staging/claude/.\n' +
        'Export from claude.ai -> Settings -> Privacy -> Export data (covers web + Desktop), ' +
        'unzip, and copy conversations.json (+ memories.json, design_chats/) there ' +
        '(see store/staging/STAGING.md).',
    );
    process.exitCode = 1;
  } else {
    const db = openDb();
    try {
      const r = ingestClaudeStaging(db);
      console.log(
        `Matrix claude-ai ingest: ${r.conversations} conversation(s) -> ${r.convInserted} turns, ` +
          `memories +${r.memInserted}, design_chats +${r.designInserted}`,
      );
      process.exitCode = 0;
    } catch (err: unknown) {
      console.error(
        `Matrix claude-ai ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}

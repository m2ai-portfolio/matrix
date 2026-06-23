// Matrix Phase 3 — Tier-B ChatGPT export connector.
//
// Parses a ChatGPT data-export `conversations.json` (an array of conversations,
// each a `mapping` tree of message nodes) into the warehouse conversation_turn
// table as source=chatgpt, reusing the Phase 0 content-hash for dedupe. A re-run
// over the same export inserts 0 rows (INSERT OR IGNORE on the turn_id PK).
//
// SHARDING (observed 2026-06-22): the official export now splits the corpus into
// `conversations-000.json`, `conversations-001.json`, ... (~100 conversations
// each) rather than a single `conversations.json`. The staging resolver
// (defaultExportFiles) globs BOTH the canonical single file and the shards, so a
// raw export drop ingests with no manual merge. `shared_conversations.json`
// (share-link metadata, not conversations) is deliberately excluded.
//
// Read-only over the staged export file(s); only the warehouse DB is written. The
// export is a point-in-time blob staged under store/staging/chatgpt/
// (see store/staging/STAGING.md). Embedding the new turns is a separate step
// (scripts/embed-batch.ts), exactly as for the other connectors.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { applySchema } from '../db/schema.js';
import { turnId } from './claude-code.js';
import { openDb } from '../db/open.js';

const SOURCE = 'chatgpt';

// Roles kept as real conversation turns. The export also carries 'system' (often
// hidden custom-instruction / context) and 'tool' (browsing / python results);
// we keep the human thinking corpus = user + assistant, matching the claude-code
// connector (which only ingests user/assistant turns).
const KEPT_ROLES = new Set(['user', 'assistant']);

// ---- Export shape (only the fields we read; everything else is ignored). ----

interface ChatMessageContent {
  content_type?: string;
  /** Text content: array of strings (multimodal mixes strings + asset objects). */
  parts?: unknown[];
  /** Some content_types (code, execution_output) carry `text` instead of parts. */
  text?: unknown;
}
interface ChatMessage {
  id?: string;
  author?: { role?: string };
  create_time?: number | null;
  content?: ChatMessageContent | null;
  metadata?: { is_visually_hidden_from_conversation?: boolean };
}
interface ChatNode {
  id?: string;
  message?: ChatMessage | null;
  parent?: string | null;
  children?: string[];
}
export interface ChatConversation {
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  id?: string;
  conversation_id?: string;
  mapping?: Record<string, ChatNode>;
  default_model_slug?: string;
  gizmo_id?: string | null;
}

export interface ChatgptIngestResult {
  conversations: number;
  /** Nodes that normalized to a real turn. */
  seen: number;
  /** New rows actually inserted (deduped). */
  inserted: number;
  /** Nodes skipped (null message, non-kept role, hidden, or no text). */
  skipped: number;
}

/** First non-empty (trimmed) string among the args, else ''. */
function firstNonEmpty(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return '';
}

/**
 * Extract human-readable text from a ChatGPT message content. `parts` is the
 * common case (string[]); multimodal_text mixes strings with asset-pointer
 * objects, so we concatenate ONLY the string parts. A few content types (code,
 * execution_output) carry `text` instead of parts. Anything else yields ''.
 */
export function extractChatgptText(content: ChatMessageContent | null | undefined): string {
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content.parts)) {
    let out = '';
    for (const p of content.parts) {
      if (typeof p === 'string') out += p;
      // non-string parts are asset pointers (image/audio); they carry no text.
    }
    return out;
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

/** A normalized ChatGPT turn (pre-hash); identity fields + lineage. */
export interface NormalizedChatTurn {
  source_id: string;
  conversation_id: string;
  role: string;
  content: string;
  ts: string;
  meta: string;
}

/**
 * Map one mapping node to a normalized turn, or null to skip. Skip rules:
 * null message (tree root / placeholder), role not in KEPT_ROLES (system/tool),
 * a node explicitly hidden from the conversation, or no extractable text.
 */
export function normalizeNode(node: ChatNode, conv: ChatConversation): NormalizedChatTurn | null {
  const msg = node.message;
  if (!msg) return null;
  const role = msg.author?.role ?? '';
  if (!KEPT_ROLES.has(role)) return null;
  if (msg.metadata?.is_visually_hidden_from_conversation === true) return null;

  const content = extractChatgptText(msg.content);
  if (content.trim() === '') return null;

  const conversation_id = firstNonEmpty(conv.conversation_id, conv.id, conv.title);
  const source_id = firstNonEmpty(msg.id, node.id);

  const createSec =
    typeof msg.create_time === 'number'
      ? msg.create_time
      : typeof conv.create_time === 'number'
        ? conv.create_time
        : undefined;
  const ts =
    createSec !== undefined && Number.isFinite(createSec)
      ? new Date(createSec * 1000).toISOString()
      : '';

  const meta = JSON.stringify({
    title: conv.title ?? null,
    model: conv.default_model_slug ?? null,
    gizmo_id: conv.gizmo_id ?? null,
    content_type: msg.content?.content_type ?? null,
    node_id: node.id ?? null,
  });

  return { source_id, conversation_id, role, content, ts, meta };
}

/**
 * Ingest an array of ChatGPT conversations into the warehouse. Reuses Phase 0
 * turnId() for content-hash dedupe; INSERT OR IGNORE on the PK gives idempotency.
 * `batchId` is lineage only (NOT part of the hash).
 */
export function ingestChatgptConversations(
  db: Database.Database,
  conversations: ChatConversation[],
  batchId = 'chatgpt-export',
): ChatgptIngestResult {
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

  const run = db.transaction((convs: ChatConversation[]) => {
    for (const conv of convs) {
      const mapping = conv.mapping ?? {};
      for (const node of Object.values(mapping)) {
        const t = normalizeNode(node, conv);
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
          project: '', // ChatGPT has no git-joinable project; empty excludes it from Mine.
          meta: t.meta,
        });
        if (res.changes === 1) inserted++;
      }
    }
  });
  run(conversations);

  return { conversations: conversations.length, seen, inserted, skipped };
}

/**
 * Parse a staged conversations.json and ingest it. Accepts either the canonical
 * bare array or a `{ conversations: [...] }` wrapper. Throws on unreadable /
 * unparseable input (fail toward the human; the card poller counts the attempt).
 */
export function ingestChatgptExport(db: Database.Database, filePath: string): ChatgptIngestResult {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  let conversations: ChatConversation[];
  if (Array.isArray(parsed)) {
    conversations = parsed as ChatConversation[];
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { conversations?: unknown }).conversations)
  ) {
    conversations = (parsed as { conversations: ChatConversation[] }).conversations;
  } else {
    throw new Error('conversations.json is neither an array nor a { conversations: [...] } object');
  }
  return ingestChatgptConversations(db, conversations, filePath);
}

/** Staging dir for ChatGPT exports: <repo>/store/staging/chatgpt/. */
function stagingDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  return join(repoRoot, 'store', 'staging', 'chatgpt');
}

/** Default staged export path: <repo>/store/staging/chatgpt/conversations.json. */
export function defaultExportPath(): string {
  return join(stagingDir(), 'conversations.json');
}

/**
 * True for a file that holds conversations: the canonical `conversations.json`
 * OR a `conversations-<n>.json` shard. False for `shared_conversations.json`
 * (share-link metadata), `conversation_asset_file_names.json`, and everything
 * else. Anchored to the start so `shared_conversations.json` does NOT match.
 */
export function isConversationsFile(name: string): boolean {
  return name === 'conversations.json' || /^conversations-\d+\.json$/.test(name);
}

/**
 * Resolve every staged ChatGPT conversations file under store/staging/chatgpt/:
 * the single `conversations.json` and/or the sharded `conversations-NNN.json`
 * form the official export now ships. Sorted absolute paths; empty when nothing
 * is staged (the dir is absent or holds no matching file).
 */
export function defaultExportFiles(): string[] {
  const root = stagingDir();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (!isConversationsFile(name)) continue;
    const p = join(root, name);
    if (statSync(p).isFile()) out.push(p);
  }
  return out.sort();
}

/**
 * Ingest every staged ChatGPT file (single conversations.json and/or sharded
 * conversations-NNN.json), aggregating the per-file results. Idempotent: re-runs
 * — and an overlapping merged-plus-shards drop — insert 0 new rows via the
 * content-hash PK.
 */
export function ingestChatgptStaging(
  db: Database.Database,
  files: string[] = defaultExportFiles(),
): ChatgptIngestResult {
  const agg: ChatgptIngestResult = { conversations: 0, seen: 0, inserted: 0, skipped: 0 };
  for (const f of files) {
    const r = ingestChatgptExport(db, f);
    agg.conversations += r.conversations;
    agg.seen += r.seen;
    agg.inserted += r.inserted;
    agg.skipped += r.skipped;
  }
  return agg;
}

// Auto-run only when invoked directly (node dist/connectors/chatgpt.js).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // An explicit path arg ingests just that file; otherwise glob the staging dir.
  const arg = process.argv[2];
  const files = arg ? [arg] : defaultExportFiles();
  if (files.length === 0) {
    console.error(
      'Matrix chatgpt ingest: no conversations.json / conversations-*.json found under ' +
        'store/staging/chatgpt/\n' +
        'Export from chatgpt.com -> Settings -> Data Controls -> Export data, unzip, and copy ' +
        'conversations.json (or the conversations-NNN.json shards) there (see store/staging/STAGING.md).',
    );
    process.exitCode = 1;
  } else {
    const db = openDb();
    try {
      let totalIn = 0;
      for (const f of files) {
        const r = ingestChatgptExport(db, f);
        console.log(
          `Matrix chatgpt ingest [${basename(f)}]: ${r.conversations} conv, ${r.seen} seen, ` +
            `${r.inserted} inserted, ${r.skipped} skipped`,
        );
        totalIn += r.inserted;
      }
      console.log(`Matrix chatgpt ingest: ${totalIn} inserted across ${files.length} file(s)`);
      process.exitCode = 0;
    } catch (err: unknown) {
      console.error(
        `Matrix chatgpt ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}

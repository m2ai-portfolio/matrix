// Matrix — recurring ingest + embed refresh (the "keep the warehouse current" loop).
//
// One pass: re-run every connector that has a source on disk, then embed whatever
// is newly un-embedded. Everything is idempotent (content-hash dedupe / INSERT OR
// IGNORE), so re-running is safe and a quiet day inserts ~0 rows.
//   - Claude Code CLI transcripts (~/.claude/projects/*.jsonl) — fresh every day.
//   - Tier-B staged exports (chatgpt / gemini / claude.ai) — picked up when dropped.
//   - CCOS claudeclaw.db (read-only pull).
//   - Embed all un-embedded turns into the 3072-dim index (gemini-embedding-001).
//
// Lives in src/ so it compiles to dist/refresh/run.js and the cron wrapper runs it
// as `node dist/refresh/run.js [concurrency] [--no-embed]` (no tsx dependency).
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Database } from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { ingestFiles, enumerateTranscripts } from '../connectors/claude-code.js';
import {
  ingestChatgptStaging,
  defaultExportFiles as chatgptExportFiles,
} from '../connectors/chatgpt.js';
import { ingestGeminiFile, defaultGeminiExportFiles } from '../connectors/gemini.js';
import { ingestClaudeStaging } from '../connectors/claude-ai.js';
import { ingestCcos } from '../connectors/ccos.js';
import { runEmbedWorker } from '../embed/worker.js';
import { realEmbedder, type Embedder } from '../embed/embedder.js';

const CCOS_DB = '/opt/claudeclaw-os/store/claudeclaw.db';

export interface RefreshOptions {
  /** Embed un-embedded turns after ingesting. Default true. */
  embed?: boolean;
  /** Embed pool size. Default 16. */
  concurrency?: number;
  /** Injectable embedder (tests). Default the real gemini-embedding-001 embedder. */
  embedder?: Embedder;
  /** DB handle (tests). Default opens the repo warehouse and closes it. */
  db?: Database;
  /** Logger. Default console.log. */
  log?: (label: string, payload: unknown) => void;
}

/** Retry wrapper so a transient 429/network blip backs off instead of aborting the pool. */
export function withRetry(e: Embedder, tries = 5): Embedder {
  return async (text: string): Promise<number[]> => {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        return await e(text);
      } catch (err) {
        if (attempt >= tries) throw err;
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  };
}

/** Run one ingest (+ optional embed) refresh pass. */
export async function runRefresh(opts: RefreshOptions = {}): Promise<void> {
  const embed = opts.embed ?? true;
  const concurrency = opts.concurrency ?? 16;
  const log =
    opts.log ??
    ((label: string, payload: unknown) =>
      console.log(`[refresh] ${label}: ${JSON.stringify(payload)}`));
  const ownsDb = opts.db === undefined;
  const db = opts.db ?? openDb();

  try {
    // 1. Claude Code CLI transcripts (the daily-fresh source).
    log('claude_code', ingestFiles(db, enumerateTranscripts()));

    // 2. Tier-B staged exports — idempotent; silent no-op when nothing is staged.
    // ChatGPT globs the single conversations.json AND any conversations-NNN.json shards.
    const cgFiles = chatgptExportFiles();
    if (cgFiles.length > 0) log('chatgpt', ingestChatgptStaging(db, cgFiles));

    for (const f of defaultGeminiExportFiles()) log('gemini', ingestGeminiFile(db, f));

    log('claude_ai', ingestClaudeStaging(db));

    // 3. CCOS read-only pull (idempotent; also loads any pre-existing vectors).
    log('ccos', ingestCcos(db, CCOS_DB));

    // 4. Embed everything still un-embedded.
    if (!embed) {
      log('embed', 'skipped (--no-embed)');
      return;
    }
    const t0 = Date.now();
    const embedder = opts.embedder ?? withRetry(realEmbedder);
    const res = await runEmbedWorker(db, { embedder, concurrency });
    log('embed', { ...res, elapsed_s: ((Date.now() - t0) / 1000).toFixed(1) });
  } finally {
    if (ownsDb) db.close();
  }
}

// Auto-run only when invoked directly (node dist/refresh/run.js).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const embed = !process.argv.includes('--no-embed');
  const concArg = process.argv.find((a) => /^\d+$/.test(a));
  const concurrency = concArg ? Number(concArg) : 16;
  runRefresh({ embed, concurrency })
    .then(() => {
      console.log('[refresh] done');
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      console.error(`[refresh] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

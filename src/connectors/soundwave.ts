/**
 * soundwave.ts — connector: Soundwave article grades -> Matrix warehouse.
 *
 * Soundwave's discovery ETL surfaces AI articles; the owner grades them up/down in the
 * digest UI, and those verdicts land in ~/notes/me2me-feedback.json. That is a rare
 * LABELED preference signal that today dead-ends as a content filter. This connector
 * maps each Soundwave-discovered grade into a conversation_turn row (Option A) so it
 * flows through the existing embed-batch job and becomes queryable warehouse data.
 *
 * Mirrors the other connectors field-for-field: reuses the shared turnId() content
 * hash and insertTurn() INSERT OR IGNORE from claude-code.ts, and applySchema() from
 * db/schema.ts. Embedding is NOT done here (separate gated scripts/embed-batch.ts job):
 * a new turn lands with no embedding row and the embed worker picks it up later.
 *
 * SCOPE: only grades with tag === 'discovered' (the Soundwave lane). Email-triage
 * self-sent grades (other tags) are a separate lane with no seen.json url and are an
 * out-of-scope sibling connector. The dry-run reports the lane split so the boundary
 * is visible, not silent.
 *
 * Run the dry-run (writes NOTHING to the live matrix.db; uses an in-memory DB):
 *   npx tsx src/connectors/soundwave.ts --dry-run [--enrich] [--out <report.md>]
 *
 * Run the GATED live ingest (writes the enriched 27 turns to the live store/matrix.db;
 * self-HALTs inside the matrix cron window 05:00-07:00 CT — refresh 05:30 + mine 06:30):
 *   source ~/.env.shared && npx tsx src/connectors/soundwave.ts --ingest [--force]
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { applySchema } from '../db/schema.js';
import { openDb } from '../db/open.js';
import { turnId, insertTurn, type NormalizedTurn } from './claude-code.js';

/*
 * NEXT (decisions ratified 2026-06-25, after the dry-run; live ingest is a separate HIL gate):
 *  - Option A RATIFIED: map grades into conversation_turn (this module's shape). No grades table.
 *  - ENRICH BEFORE EMBED: the live path must re-fetch each grade's url for article body/summary
 *    and fold it into `content` (today content = title + rating notes only; the body is thin).
 *    That adds a fetch step + a dead-link failure mode (Soundwave's fetch() retry pattern applies).
 *  - Live ingest stays gated: must run outside the matrix cron windows (refresh 05:30, mine 06:30,
 *    fleet-populate/bridge) or behind its own lock, against the 4.46GB live store/matrix.db.
 *  - Scope stays the Soundwave lane (tag === 'discovered'); the 77 email-triage grades are a
 *    separate email-triage -> Matrix sibling connector, not this one.
 */
export const SOURCE = 'soundwave';
export const ROLE = 'article';
export const SOUNDWAVE_TAG = 'discovered';

const FEEDBACK_PATH = `${homedir()}/notes/me2me-feedback.json`;
const SEEN_PATH = `${homedir()}/.claude/soundwave-discover/seen.json`;

/** One raw grade record from me2me-feedback.json. */
export interface Grade {
  id: string;
  title: string;
  tag?: string;
  verdict?: string; // 'up' | 'down'
  notes?: string;
  ts?: string;
  batch?: string;
  source?: string; // registrable domain (present on discovered grades)
}

/** seen.json value: id -> article identity (carries the url the grade record lacks). */
export interface SeenEntry {
  first_seen?: string;
  url?: string;
  title?: string;
  source?: string;
}

/**
 * Pure transform: one graded article -> one NormalizedTurn (Option A mapping).
 * `seen` supplies the url the grade record itself does not store. Content embeds the
 * title plus the owner's rating rationale (notes), which is itself part of the labeled
 * signal; the article body is not stored anywhere, so it cannot be embedded here.
 */
export function gradeToTurn(grade: Grade, seen?: SeenEntry): NormalizedTurn {
  const url = seen?.url ?? '';
  const domain = grade.source ?? seen?.source ?? '';
  const notes = (grade.notes ?? '').trim();
  const content = notes ? `${grade.title}\n\n${notes}` : grade.title;
  const base = {
    source: SOURCE,
    source_id: grade.id,
    conversation_id: grade.batch ?? '',
    role: ROLE,
    content,
  };
  const meta = JSON.stringify({
    verdict: grade.verdict ?? null,
    notes: notes || null,
    tag: grade.tag ?? null,
    batch: grade.batch ?? null,
    domain: domain || null,
    url: url || null,
  });
  return {
    turn_id: turnId(base),
    ...base,
    ingestion_batch_id: FEEDBACK_PATH,
    ts: grade.ts ?? '',
    tokens: null,
    project: '',
    meta,
  };
}

// --- Enrichment (ENRICH BEFORE EMBED, ratified 2026-06-25) -------------------------------
// The dry-run embedded title + rating notes only — too thin. The live path re-fetches each
// grade's article url for body text and folds it into `content`, so the embedding carries the
// article, not just the headline. A dead/blocked/timeout url FALLS BACK to the title+notes
// content (the same string the dry-run used) and the row is LOGGED as a fallback, never skipped.

/** Browser UA + retry/backoff ported from email-triage/soundwave_discover.py fetch(). */
const ENRICH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ENRICH_BACKOFF_MS = [2000, 5000]; // matches the Python (2s, 5s)
const ENRICH_RETRY_STATUS = new Set([429, 502, 503]);
const ENRICH_BODY_LIMIT = 2000; // chars of article body folded into content

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GET with a browser UA, following redirects, retrying transient 429/502/503 with a short
 * backoff (the same failure modes the Python connector hit on VentureBeat/reddit). Throws on
 * a permanent error or after the final retry. `fetchFn` is injectable so tests never hit the
 * network. A 25s per-attempt timeout mirrors the Python urlopen timeout.
 */
export async function fetchArticle(
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  retries = 2,
  backoff: number[] = ENRICH_BACKOFF_MS,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      resp = await fetchFn(url, {
        headers: { 'User-Agent': ENRICH_UA, Accept: 'text/html,application/xhtml+xml,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      // AbortError / network error: retry the cheap remaining attempts, then give up.
      lastErr = e;
      if (attempt < retries) {
        await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
        continue;
      }
      throw lastErr;
    }
    if (resp.ok) return await resp.text();
    // Status-based decision is explicit (not caught): only 429/502/503 retry; the rest are
    // permanent and throw immediately, matching the Python connector's raise-on-permanent.
    if (ENRICH_RETRY_STATUS.has(resp.status) && attempt < retries) {
      await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
      continue;
    }
    throw new Error(`HTTP ${resp.status}`);
  }
  throw lastErr; // unreachable; the loop returns or throws
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Strip an HTML document to readable text: drop script/style/noscript blocks, remove tags,
 * decode the common entities, collapse whitespace, and cap at `limit` chars. Stdlib-only
 * (no cheerio dep) and deterministic — same approach as the Python clean_summary().
 */
export function htmlToText(html: string, limit = ENRICH_BODY_LIMIT): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  t = t.replace(/&#?[a-z0-9]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > limit ? t.slice(0, limit - 1) + '…' : t;
}

export interface EnrichResult {
  /** content to embed: title+notes, plus the article body when the fetch succeeded. */
  content: string;
  /** true when the url was missing/dead/blocked and we fell back to title+notes (logged, not skipped). */
  fellBack: boolean;
}

/**
 * Enrich one grade's embeddable content with its article body. On any failure (no url, fetch
 * error, empty body) returns the title+notes content and fellBack=true so the caller logs the
 * row instead of dropping it.
 */
export async function enrichContent(
  grade: Grade,
  seen?: SeenEntry,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<EnrichResult> {
  const base = gradeToTurn(grade, seen).content; // stable title+notes string (the fallback)
  const url = seen?.url ?? '';
  if (!url) return { content: base, fellBack: true };
  try {
    const body = htmlToText(await fetchArticle(url, fetchFn));
    if (!body) return { content: base, fellBack: true };
    return { content: `${base}\n\n${body}`, fellBack: false };
  } catch {
    return { content: base, fellBack: true };
  }
}

/**
 * Build the live NormalizedTurn from an enriched content string. The turn_id stays the STABLE
 * identity hash of the title+notes base (gradeToTurn), NOT a hash of the volatile fetched body:
 * a graded article's identity is the grade, so a re-run whose fetched body drifted still dedupes
 * via INSERT OR IGNORE instead of inserting a near-duplicate. The dry-run's predicted turn_ids
 * therefore match the live rows exactly. Only `content` (what gets embedded) carries the body.
 */
export function gradeToTurnEnriched(
  grade: Grade,
  seen: SeenEntry | undefined,
  enrichedContent: string,
): NormalizedTurn {
  return { ...gradeToTurn(grade, seen), content: enrichedContent };
}

export interface LoadResult {
  total: number;
  soundwaveGrades: Grade[]; // tag === discovered
  otherLaneCount: number; // email-triage self-sent grades (out of scope)
  seen: Record<string, SeenEntry>;
  urlMatched: number; // soundwave grades whose id resolved to a url
  urlCoverage: number; // urlMatched / soundwaveGrades.length
}

/** Read both JSON sources, isolate the Soundwave lane, and measure id->url coverage. */
export function loadGrades(feedbackPath = FEEDBACK_PATH, seenPath = SEEN_PATH): LoadResult {
  const fb = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as Record<string, Grade>;
  const seen = JSON.parse(readFileSync(seenPath, 'utf-8')) as Record<string, SeenEntry>;
  const all = Object.values(fb);
  const soundwaveGrades = all.filter((g) => g.tag === SOUNDWAVE_TAG);
  const urlMatched = soundwaveGrades.filter((g) => Boolean(seen[g.id]?.url)).length;
  return {
    total: all.length,
    soundwaveGrades,
    otherLaneCount: all.length - soundwaveGrades.length,
    seen,
    urlMatched,
    urlCoverage: soundwaveGrades.length ? urlMatched / soundwaveGrades.length : 0,
  };
}

export interface DryRunResult {
  load: LoadResult;
  wouldInsert: number;
  duplicateTurnIds: number;
  embedQueueDelta: number; // turns with no embedding row (all of them, embedding is empty)
  samples: NormalizedTurn[];
  errors: string[];
  liveDbOpened: false;
}

/**
 * Dry-run: build the real schema in an in-memory DB, run every Soundwave grade through
 * the transform + the real insertTurn (INSERT OR IGNORE), and report what a live ingest
 * WOULD do. Never opens the live store/matrix.db.
 */
export function dryRun(coverageThreshold = 0.9): DryRunResult {
  const load = loadGrades();
  const errors: string[] = [];
  const db = new Database(':memory:'); // in-memory ONLY — the live warehouse is never touched
  applySchema(db);

  let wouldInsert = 0;
  let duplicateTurnIds = 0;
  const samples: NormalizedTurn[] = [];
  for (const grade of load.soundwaveGrades) {
    try {
      const turn = gradeToTurn(grade, load.seen[grade.id]);
      const inserted = insertTurn(db, turn);
      if (inserted) wouldInsert += 1;
      else duplicateTurnIds += 1;
      if (samples.length < 3) samples.push(turn);
    } catch (e) {
      errors.push(`${grade.id}: ${(e as Error).message}`);
    }
  }

  // embed-queue delta: turns present with no embedding row for the canonical model.
  const embedQueueDelta = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_turn t
           LEFT JOIN embedding e ON e.turn_id = t.turn_id
          WHERE e.turn_id IS NULL`,
      )
      .get() as { n: number }
  ).n;

  db.close();

  // kill gate: low url coverage or any transform error halts before any live write.
  if (load.urlCoverage < coverageThreshold) {
    errors.push(
      `[HALT] id->url coverage ${(load.urlCoverage * 100).toFixed(0)}% < ${(coverageThreshold * 100).toFixed(0)}% threshold`,
    );
  }
  return {
    load,
    wouldInsert,
    duplicateTurnIds,
    embedQueueDelta,
    samples,
    errors,
    liveDbOpened: false,
  };
}

// --- Gated live ingest -------------------------------------------------------------------
// The ONLY writers to the live store/matrix.db are the refresh cron (05:30 CT) and the mine
// cron (06:30 CT). (The fleet-populate */2 and bridge */5 crons write matrix-ops.db / route
// file cards — they never touch matrix.db, so they are NOT a contention source.) The self-guard
// therefore HALTs inside 05:00-07:00 CT, covering both matrix.db writers with margin.

/** True if `d` (default now) is inside the matrix.db cron window 05:00-07:00 America/Chicago. */
export function inCronWindow(d: Date = new Date()): boolean {
  const hourCT = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'America/Chicago',
    }).format(d),
  );
  return hourCT >= 5 && hourCT < 7;
}

export interface RunReport {
  halted: boolean;
  reason?: string;
  inScope: number; // Soundwave-lane grades considered
  inserted: number; // new rows written (INSERT OR IGNORE changed)
  skipped: number; // duplicate turn_ids already present
  fellBack: string[]; // grade ids that fell back to title+notes (logged, not dropped)
  enriched: number; // grades whose article body was successfully folded in
  liveDbOpened: boolean;
  errors: string[];
}

export interface IngestDeps {
  now?: Date;
  force?: boolean; // bypass the cron-window guard (for an explicit off-window manual run)
  db?: Database.Database; // injectable; default openDb() -> live store/matrix.db
  load?: LoadResult; // injectable; default loadGrades()
  fetchFn?: typeof globalThis.fetch;
  coverageThreshold?: number;
}

/**
 * Gated live ingest of the enriched Soundwave-lane grades into the live conversation_turn.
 * HALTs (writes nothing) if inside the cron window (unless force) or if id->url coverage drops
 * below threshold. Enriches each grade (fetch + fold body; fall back to title+notes on failure),
 * then INSERT OR IGNORE. Embedding is a SEPARATE gated step (scripts/embed-batch.ts).
 */
export async function ingestLive(deps: IngestDeps = {}): Promise<RunReport> {
  const now = deps.now ?? new Date();
  const threshold = deps.coverageThreshold ?? 0.9;
  const empty: RunReport = {
    halted: true,
    inScope: 0,
    inserted: 0,
    skipped: 0,
    fellBack: [],
    enriched: 0,
    liveDbOpened: false,
    errors: [],
  };

  if (!deps.force && inCronWindow(now)) {
    return { ...empty, reason: '[HALT] inside matrix cron window 05:00-07:00 CT (refresh/mine)' };
  }

  const load = deps.load ?? loadGrades();
  if (load.urlCoverage < threshold) {
    return {
      ...empty,
      inScope: load.soundwaveGrades.length,
      reason: `[HALT] id->url coverage ${(load.urlCoverage * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%`,
    };
  }

  const ownDb = deps.db === undefined;
  const db = deps.db ?? openDb(); // live store/matrix.db
  if (ownDb) db.pragma('busy_timeout = 10000'); // tolerate the board reader / a passing cron
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  let inserted = 0;
  let skipped = 0;
  let enriched = 0;
  const fellBack: string[] = [];
  const errors: string[] = [];

  for (const grade of load.soundwaveGrades) {
    try {
      const enr = await enrichContent(grade, load.seen[grade.id], fetchFn);
      if (enr.fellBack) fellBack.push(grade.id);
      else enriched += 1;
      const turn = gradeToTurnEnriched(grade, load.seen[grade.id], enr.content);
      if (insertTurn(db, turn)) inserted += 1;
      else skipped += 1;
    } catch (e) {
      errors.push(`${grade.id}: ${(e as Error).message}`);
    }
  }

  if (ownDb) db.close();
  return {
    halted: false,
    inScope: load.soundwaveGrades.length,
    inserted,
    skipped,
    fellBack,
    enriched,
    liveDbOpened: true,
    errors,
  };
}

/**
 * Enriched dry-run: run the real enrichment over every Soundwave grade against an in-memory DB,
 * reporting enriched-content samples + the fallback count. Writes NOTHING to the live store.
 */
export async function enrichedDryRun(fetchFn: typeof globalThis.fetch = globalThis.fetch): Promise<{
  report: RunReport;
  samples: NormalizedTurn[];
}> {
  const db = new Database(':memory:');
  applySchema(db);
  const load = loadGrades();
  const report = await ingestLive({ db, load, fetchFn, force: true });
  const samples = db
    .prepare(`SELECT * FROM conversation_turn WHERE source = ? ORDER BY ts DESC LIMIT 3`)
    .all(SOURCE) as unknown as NormalizedTurn[];
  db.close();
  return { report, samples };
}

function renderReport(r: DryRunResult): string {
  const { load } = r;
  const halted = r.errors.some((e) => e.includes('[HALT]'));
  const lines = [
    '# Soundwave -> Matrix connector — DRY-RUN report',
    '',
    `Date: 2026-06-25 · scope: Soundwave lane (tag === '${SOUNDWAVE_TAG}') · Option A (map into conversation_turn)`,
    `Verdict: ${halted || r.errors.length ? 'HALT / see errors' : 'PASS — safe to ratify Option A'}`,
    '',
    '## Source data',
    `- me2me-feedback.json total grades: ${load.total}`,
    `- Soundwave-lane grades (in scope): ${load.soundwaveGrades.length}`,
    `- Email-triage-lane grades (OUT of scope, sibling connector): ${load.otherLaneCount}`,
    `- id->url join coverage (Soundwave lane): ${load.urlMatched}/${load.soundwaveGrades.length} = ${(load.urlCoverage * 100).toFixed(0)}%`,
    '',
    '## What a live ingest WOULD do (simulated in :memory:, zero live writes)',
    `- rows that would INSERT: ${r.wouldInsert}`,
    `- duplicate turn_ids skipped (INSERT OR IGNORE): ${r.duplicateTurnIds}`,
    `- embed-queue delta (new turns the embed-batch job would pick up): ${r.embedQueueDelta}`,
    `- transform errors: ${r.errors.length ? r.errors.join('; ') : 'none'}`,
    `- live store/matrix.db opened: ${r.liveDbOpened}`,
    '',
    '## Sample normalized rows (first 3)',
    '```json',
    JSON.stringify(
      r.samples.map((s) => ({ ...s, content: s.content.slice(0, 120) })),
      null,
      2,
    ),
    '```',
    '',
    '## Decision this informs (Option A vs B)',
    '- Option A (this run): grades become conversation_turn rows and embed for free via the existing job.',
    '- Option B: a dedicated grades table (cleaner, but no free embed + a schema change).',
    '- Open caveat: content embeds the title + rating notes only; the article BODY is not stored',
    '  anywhere, so the embedding is thin. Decide whether that is acceptable before a live ingest.',
  ];
  return lines.join('\n');
}

// CLI entry: only runs when invoked directly (mirrors the other connectors' pattern).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const run = async (): Promise<number> => {
    // --ingest: gated LIVE write to store/matrix.db (self-HALTs in the cron window).
    if (args.includes('--ingest')) {
      const report = await ingestLive({ force: args.includes('--force') });
      console.log(JSON.stringify(report, null, 2));
      if (report.halted) {
        console.error(`\n[soundwave ingest] HALTED: ${report.reason}`);
        return 1;
      }
      console.error(
        `\n[soundwave ingest] inserted=${report.inserted} skipped=${report.skipped} ` +
          `enriched=${report.enriched} fellBack=${report.fellBack.length} ` +
          `[${report.fellBack.join(', ') || 'none'}]`,
      );
      console.error('[soundwave ingest] NEXT: embed via scripts/embed-batch.ts, then verify.');
      return report.errors.length ? 1 : 0;
    }

    if (!args.includes('--dry-run')) {
      console.error(
        'usage: soundwave.ts --dry-run [--enrich] [--out <report.md>] | --ingest [--force]',
      );
      return 2;
    }

    // --dry-run --enrich: run the real enrichment, report samples + fallback count, write nothing live.
    if (args.includes('--enrich')) {
      const { report, samples } = await enrichedDryRun();
      console.log(JSON.stringify(report, null, 2));
      console.log(
        '\nEnriched samples (first 3):\n' +
          JSON.stringify(
            samples.map((s) => ({ source_id: s.source_id, content: s.content.slice(0, 200) })),
            null,
            2,
          ),
      );
      console.error(
        `\n[soundwave dry-run --enrich] inScope=${report.inScope} enriched=${report.enriched} ` +
          `fellBack=${report.fellBack.length} [${report.fellBack.join(', ') || 'none'}] (no live write)`,
      );
      return report.errors.length ? 1 : 0;
    }

    // --dry-run: the original transform-only simulation (no fetch, no live write).
    const outIdx = args.indexOf('--out');
    const outPath =
      outIdx >= 0 && args[outIdx + 1]
        ? args[outIdx + 1]
        : `${homedir()}/notes/planning/2026-06-25/soundwave-matrix-dryrun-report.md`;
    const result = dryRun();
    const report = renderReport(result);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report + '\n', 'utf-8');
    console.log(report);
    console.error(`\n[soundwave dry-run] report written to ${outPath}`);
    return result.errors.some((e) => e.includes('[HALT]')) ? 1 : 0;
  };
  run().then((code) => process.exit(code));
}

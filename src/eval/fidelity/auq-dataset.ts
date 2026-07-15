// Matrix forced-choice fidelity eval (AUQ lane): dataset extractor + warehouse loader.
// See ./AUQ-CONTRACT.md. This lane is N-alternative forced choice (predict which option the owner
// picked), NOT the binary up/down of the Soundwave lane, so it carries its own types and loader.
//
// Source: Claude Code transcripts ~/.claude/projects/*/*.jsonl. Each AskUserQuestion `tool_use`
// holds the question + labeled options; the matching `tool_result` (by tool_use_id) holds the pick
// as `Your questions have been answered: "<question>"="<chosen-label>"`. A CLEAN triple is one whose
// recorded answer string-matches one of the offered option labels (leak-free + balanced by
// construction). The situation (question text) is embedded under a DISTINCT model key so the AUQ
// vectors never collide with the warehouse's conversation vectors.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Database } from 'better-sqlite3';
import { decodeVector } from './dataset.js';
import { EMBED_MODEL } from '../../db/vec.js';

/**
 * The distinct embedding model key for AUQ situations: isolates these vectors from conversation
 * vectors. Derived from the canonical EMBED_MODEL so a warehouse model migration re-queues the
 * AUQ situations under the new key automatically (rows under the old key persist, same as the
 * conversation lane).
 */
export const AUQ_SITUATION_MODEL = `${EMBED_MODEL}#auq-situation`;

/** One clean forced-choice triple: a situation, the offered labels, and the picked label. */
export interface AuqTriple {
  /** Stable id `auq:<tool_use_id>:<questionIdx>`. Used as the embedding table turn_id. */
  id: string;
  /** Question text (+ header). The leak guard asserts this contains none of its option labels. */
  situation: string;
  /** Short header/topic tag from the AUQ question (may be ''). */
  header: string;
  /** Offered option labels, in their original order. */
  options: string[];
  /** The picked label (one of `options`). */
  chosen: string;
  /** Index of `chosen` within `options`. */
  chosenIdx: number;
  /** The non-chosen labels. */
  rejected: string[];
  /** Index of the explicit "(recommended)" option, or null if none is marked. */
  recommendedIdx: number | null;
  /** True for the (rare) multiSelect question; a strict single-pick eval may exclude these. */
  multiSelect: boolean;
  /** Situation embedding pulled from the embedding table (only present after loadAuqTriples). */
  vector?: Float32Array;
}

const RESULT_PREFIX = 'Your questions have been answered:';

const isRecommended = (label: string): boolean => /\(recommended\)/i.test(label);
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Lowercase word tokens (alphanumeric runs). Used for the token-aware leak check. */
function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * True if the label leaks into the situation: its word-token sequence appears as a contiguous run
 * of the situation's tokens. Token-based (not raw substring) so a one-letter label like "C" does
 * not false-match inside a word like "choice"; a real label like "Postgres" in the question does.
 */
function labelLeaks(situation: string, label: string): boolean {
  const lab = tokens(label);
  if (lab.length === 0) return false;
  const sit = tokens(situation);
  for (let i = 0; i + lab.length <= sit.length; i++) {
    let all = true;
    for (let j = 0; j < lab.length; j++) {
      if (sit[i + j] !== lab[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** Flatten a tool_result `content` (string | array of parts | object) into a single string. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string'
          ? p
          : p && typeof p === 'object' && 'text' in p
            ? String((p as { text: unknown }).text ?? '')
            : '',
      )
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as { text: unknown }).text ?? '');
  }
  return '';
}

interface AuqQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label?: string }>;
}

/**
 * Extract clean forced-choice triples from already-parsed transcript records (PURE: no filesystem).
 * Pairs each AskUserQuestion tool_use with its answered tool_result by tool_use_id, dedups by
 * tool_use_id across the whole record stream, and keeps only questions whose recorded answer matches
 * an offered option label. Triples whose situation text contains one of its own option labels are
 * dropped to keep the set leak-free by construction (the count of such drops is returned).
 */
export function extractAuqTriples(records: Iterable<unknown>): {
  triples: AuqTriple[];
  leakDropped: number;
} {
  const useById = new Map<string, AuqQuestion[]>();
  const resultById = new Map<string, string>();

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const msg = (rec as { message?: unknown }).message;
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const block = c as {
        type?: string;
        name?: string;
        id?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
      };
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id) {
        const questions = (block.input as { questions?: unknown } | undefined)?.questions;
        if (!useById.has(block.id) && Array.isArray(questions)) {
          useById.set(block.id, questions as AuqQuestion[]);
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const txt = resultText(block.content);
        if (
          txt &&
          txt.trimStart().startsWith(RESULT_PREFIX) &&
          !resultById.has(block.tool_use_id)
        ) {
          resultById.set(block.tool_use_id, txt);
        }
      }
    }
  }

  const triples: AuqTriple[] = [];
  let leakDropped = 0;
  for (const [id, questions] of useById) {
    const result = resultById.get(id);
    if (!result) continue; // unanswered / cancelled AUQ call: contributes no clean triples
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length === 0) continue;
      const qtext = typeof q.question === 'string' ? q.question : '';
      const labels = opts.map((o) => (typeof o.label === 'string' ? o.label : ''));

      // Clean iff a literal "<question>"="<label>" substring exists; normalized fallback otherwise.
      let chosenIdx = labels.findIndex((lab) => result.includes(`"${qtext}"="${lab}"`));
      if (chosenIdx === -1) {
        const anchor = `"${qtext}"="`;
        const at = result.indexOf(anchor);
        if (at !== -1) {
          const start = at + anchor.length;
          let end = result.indexOf('".', start);
          if (end === -1) end = result.length;
          const ans = norm(result.slice(start, end));
          chosenIdx = labels.findIndex((lab) => norm(lab) === ans);
        }
      }
      if (chosenIdx === -1) continue; // free-text "Other" answer: not a clean label pick

      const header = typeof q.header === 'string' ? q.header : '';
      const situation = header ? `${header}\n${qtext}` : qtext;

      // Leak guard by construction: drop any triple whose situation contains one of its labels as
      // a whole word-token sequence (token-based so short labels do not false-match inside words).
      if (labels.some((lab) => labelLeaks(situation, lab))) {
        leakDropped++;
        continue;
      }

      const recommendedIdx = labels.findIndex((lab) => isRecommended(lab));
      triples.push({
        id: `auq:${id}:${qIdx}`,
        situation,
        header,
        options: labels,
        chosen: labels[chosenIdx],
        chosenIdx,
        rejected: labels.filter((_, i) => i !== chosenIdx),
        recommendedIdx: recommendedIdx === -1 ? null : recommendedIdx,
        multiSelect: q.multiSelect === true,
      });
    }
  }
  return { triples, leakDropped };
}

/** Default Claude Code transcript root. */
export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** List every .jsonl file one level under the projects dir (the per-project glob, one dir deep). */
export function listTranscriptFiles(projectsDir = defaultProjectsDir()): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const sub of entries) {
    const dir = join(projectsDir, sub);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // not a directory
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(join(dir, f));
  }
  return out;
}

/** Read + parse a transcript file's JSONL lines, skipping unparseable lines. */
function* readRecords(file: string): Generator<unknown> {
  let data: string;
  try {
    data = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip malformed line
    }
  }
}

/** Extract clean AUQ triples from every transcript under projectsDir (IO wrapper over extractAuqTriples). */
export function extractAuqTriplesFromProjects(projectsDir = defaultProjectsDir()): {
  triples: AuqTriple[];
  leakDropped: number;
  filesScanned: number;
} {
  const files = listTranscriptFiles(projectsDir);
  function* all(): Generator<unknown> {
    for (const f of files) yield* readRecords(f);
  }
  const { triples, leakDropped } = extractAuqTriples(all());
  return { triples, leakDropped, filesScanned: files.length };
}

interface TurnRow {
  turn_id: string;
  content: string | null;
  meta: string | null;
  vector: Buffer | null;
}

/** The non-vector fields persisted to conversation_turn.meta for an AUQ triple. */
interface AuqMeta {
  options: string[];
  chosen: string;
  chosenIdx: number;
  recommendedIdx: number | null;
  header: string;
  multiSelect: boolean;
}

/**
 * Write each clean triple as a conversation_turn row (source='auq', content=situation, the
 * forced-choice fields in meta). Additive + idempotent: INSERT OR REPLACE keyed by turn_id, and
 * source='auq' isolates these rows from the warehouse's real conversation turns. Does NOT embed.
 * Returns the number of rows written.
 */
export function writeAuqTurns(db: Database, triples: AuqTriple[]): number {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO conversation_turn
       (turn_id, source, source_id, ingestion_batch_id, conversation_id, ts, role, content, tokens, project, meta)
     VALUES (@turn_id, 'auq', @source_id, 'auq-eval', NULL, NULL, 'question', @content, NULL, NULL, @meta)`,
  );
  const tx = db.transaction((rows: AuqTriple[]) => {
    for (const t of rows) {
      const meta: AuqMeta = {
        options: t.options,
        chosen: t.chosen,
        chosenIdx: t.chosenIdx,
        recommendedIdx: t.recommendedIdx,
        header: t.header,
        multiSelect: t.multiSelect,
      };
      stmt.run({
        turn_id: t.id,
        source_id: t.id.slice(0, 120),
        content: t.situation,
        meta: JSON.stringify(meta),
      });
    }
  });
  tx(triples);
  return triples.length;
}

/**
 * Load AUQ triples from the warehouse: source='auq' turns joined to their situation embedding under
 * AUQ_SITUATION_MODEL. Only triples WITH a stored vector are returned (the eval needs the vector for
 * kNN retrieval). Reads the embedding table directly (not the vec0 index), per the contract.
 */
export function loadAuqTriples(db: Database, model = AUQ_SITUATION_MODEL): AuqTriple[] {
  const rows = db
    .prepare(
      `SELECT t.turn_id AS turn_id, t.content AS content, t.meta AS meta, e.vector AS vector
         FROM conversation_turn t
         JOIN embedding e ON e.turn_id = t.turn_id AND e.model = ?
        WHERE t.source = 'auq'
        ORDER BY t.turn_id`,
    )
    .all(model) as TurnRow[];

  const triples: AuqTriple[] = [];
  for (const r of rows) {
    if (!r.meta || !r.vector) continue;
    let meta: AuqMeta;
    try {
      meta = JSON.parse(r.meta) as AuqMeta;
    } catch {
      continue;
    }
    const options = Array.isArray(meta.options) ? meta.options : [];
    if (options.length === 0) continue;
    const chosenIdx =
      typeof meta.chosenIdx === 'number' ? meta.chosenIdx : options.indexOf(meta.chosen);
    if (chosenIdx < 0 || chosenIdx >= options.length) continue;
    triples.push({
      id: r.turn_id,
      situation: r.content ?? '',
      header: typeof meta.header === 'string' ? meta.header : '',
      options,
      chosen: options[chosenIdx],
      chosenIdx,
      rejected: options.filter((_, i) => i !== chosenIdx),
      recommendedIdx: typeof meta.recommendedIdx === 'number' ? meta.recommendedIdx : null,
      multiSelect: meta.multiSelect === true,
      vector: decodeVector(r.vector),
    });
  }
  return triples;
}

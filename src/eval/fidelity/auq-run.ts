// Matrix forced-choice fidelity eval (AUQ lane): run entrypoint (extract -> embed -> eval -> report).
// See ./AUQ-CONTRACT.md. Three phases, each idempotent and separately invokable so the gated network
// steps (embed, judge) can be proven on ONE item before scaling:
//   --phase extract : pull clean AUQ triples from the transcripts, write them as source='auq' turns.
//   --phase embed   : embed each AUQ situation under AUQ_SITUATION_MODEL (skip already-embedded).
//   --phase eval    : LOO over the embedded triples; baselines + (gated) Gemini judge; write report.
//
// The warehouse store is opened READ-WRITE only for extract/embed (additive, source='auq' +
// the distinct #auq-situation model key, never touching real conversation rows); eval opens it
// read-only. Model ids are verified via /chub before any live call, never hardcoded from memory.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '../../db/open.js';
import { EMBED_DIM } from '../../db/vec.js';
import { realEmbedder, type Embedder } from '../../embed/embedder.js';
import {
  AUQ_SITUATION_MODEL,
  extractAuqTriplesFromProjects,
  writeAuqTurns,
  loadAuqTriples,
  type AuqTriple,
} from './auq-dataset.js';
import { alwaysRecommendedPredictor, judgePredictor, type ChoiceJudge } from './auq-predictors.js';
import { realGeminiChoiceJudge } from './auq-judge.js';
import {
  runAuqEval,
  type AuqEvalReport,
  type ChoicePredictorReport,
  type NamedChoicePredictor,
} from './auq-harness.js';

/** Plan kill-gate floor: below this a held-out forced-choice split is not meaningful. */
export const MIN_TRIPLES = 100;

function defaultDbPath(): string {
  return `${homedir()}/projects/matrix/store/matrix.db`;
}

// --- phase: extract ------------------------------------------------------------------

export interface ExtractResult {
  filesScanned: number;
  cleanTriples: number;
  leakDropped: number;
  written: number;
}

/** Extract clean AUQ triples from the transcripts and persist them as source='auq' turns. */
export function extractAndWrite(db: Database.Database): ExtractResult {
  const { triples, leakDropped, filesScanned } = extractAuqTriplesFromProjects();
  const written = writeAuqTurns(db, triples);
  return { filesScanned, cleanTriples: triples.length, leakDropped, written };
}

// --- phase: embed --------------------------------------------------------------------

interface PendingRow {
  turn_id: string;
  content: string | null;
}

/**
 * Embed each source='auq' situation that lacks an AUQ_SITUATION_MODEL vector, storing the EMBED_DIM
 * Float32 BLOB in the embedding table (skipping the vec0 index, per the contract). Idempotent:
 * already-embedded situations are skipped, so a re-run only fills gaps. `limit` caps the batch for
 * the prove-one step. Returns counts.
 */
export async function embedSituations(
  db: Database.Database,
  embedder: Embedder,
  opts: { limit?: number; model?: string; log?: (l: string) => void } = {},
): Promise<{ embedded: number; failed: number; pending: number }> {
  const model = opts.model ?? AUQ_SITUATION_MODEL;
  const log = opts.log ?? (() => {});
  const pending = db
    .prepare(
      `SELECT t.turn_id AS turn_id, t.content AS content
         FROM conversation_turn t
         LEFT JOIN embedding e ON e.turn_id = t.turn_id AND e.model = ?
        WHERE t.source = 'auq' AND e.turn_id IS NULL
        ORDER BY t.turn_id`,
    )
    .all(model) as PendingRow[];

  const batch = opts.limit ? pending.slice(0, opts.limit) : pending;
  const ins = db.prepare('INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)');

  let embedded = 0;
  let failed = 0;
  for (const row of batch) {
    const text = row.content ?? '';
    let values: number[];
    try {
      values = await embedder(text);
    } catch (err) {
      failed++;
      log(`[auq-embed] FAIL ${row.turn_id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!values || values.length === 0) {
      failed++;
      log(`[auq-embed] EMPTY ${row.turn_id}`);
      continue;
    }
    const blob = Buffer.from(Float32Array.from(values).buffer);
    ins.run(row.turn_id, model, values.length, blob);
    embedded++;
    if (embedded % 50 === 0) log(`[auq-embed] ${embedded}/${batch.length}`);
  }
  return { embedded, failed, pending: pending.length };
}

// --- phase: eval ---------------------------------------------------------------------

export interface AuqRunOptions {
  db: Database.Database;
  /** Inject a ChoiceJudge to add the zero-shot + kNN-few-shot judge predictors (real run wires Gemini). */
  judge?: ChoiceJudge;
  /** kNN retrieval size for the judge's few-shot examples. Default 5. */
  k?: number;
  /** Max judge folds in flight at once (network latency hiding). Default 1. */
  concurrency?: number;
  model?: string;
  /** Additive diagnostics: if set, write the per-fold ChoiceFoldResult[] (enriched with situation
   *  id/text/options) as JSONL beside the markdown report. Off by default; never changes the eval. */
  foldDumpPath?: string;
  log?: (l: string) => void;
}

export interface AuqRunResult {
  halted: boolean;
  reason?: string;
  triples: number;
  report?: AuqEvalReport;
}

/**
 * Bounded retry around a ChoiceJudge: a transient network error OR a prose-only (no-JSON) Gemini
 * reply throws inside the judge; this re-tries with backoff, and after the final attempt degrades to
 * the first option (index 0) rather than aborting the entire LOO run. Additive: the eval contract is
 * unchanged (a persistently-unparseable fold simply scores as the fallback pick, same as clampIdx).
 */
export function withJudgeRetry(judge: ChoiceJudge, attempts = 4, baseMs = 700): ChoiceJudge {
  return async (input) => {
    for (let a = 0; a < attempts; a++) {
      try {
        return await judge(input);
      } catch {
        if (a < attempts - 1) {
          await new Promise((r) => setTimeout(r, baseMs * 2 ** a + Math.random() * 200));
        }
      }
    }
    return { chosenIdx: 0 };
  };
}

/** Build the predictor list: the always-recommended baseline plus (if a judge is injected) the judge. */
export function buildPredictors(judge: ChoiceJudge | undefined, k: number): NamedChoicePredictor[] {
  const predictors: NamedChoicePredictor[] = [
    { name: 'baseline:always-recommended', predictor: alwaysRecommendedPredictor },
  ];
  if (judge) {
    predictors.push({ name: 'judge:gemini-zeroshot', predictor: judgePredictor(judge, 0) });
    predictors.push({ name: `judge:gemini-knn@${k}`, predictor: judgePredictor(judge, k) });
  }
  return predictors;
}

/** Load the embedded AUQ triples and run the forced-choice LOO eval (or HALT below MIN_TRIPLES). */
export async function runAuqFidelity(opts: AuqRunOptions): Promise<AuqRunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const triples = loadAuqTriples(opts.db, opts.model ?? AUQ_SITUATION_MODEL);
  if (triples.length < MIN_TRIPLES) {
    const reason = `[HALT] data not ready: ${triples.length} embedded AUQ triples (< ${MIN_TRIPLES}); do not fabricate a fidelity number from a degenerate set`;
    log(reason);
    return { halted: true, reason, triples: triples.length };
  }
  const predictors = buildPredictors(opts.judge, opts.k ?? 5);
  const report = await runAuqEval(triples, predictors, {
    concurrency: opts.concurrency ?? 1,
    log,
  });
  logSummary(report, log);
  if (opts.foldDumpPath) {
    writeFoldDump(report, triples, opts.foldDumpPath);
    log(`[auq-fidelity] per-fold dump written to ${opts.foldDumpPath}`);
  }
  return { halted: false, triples: triples.length, report };
}

/**
 * Additive diagnostics: dump every predictor's per-fold results as JSONL (one row per predictor+fold),
 * enriched by id-join back to the triple so the situation text/options/recommendedIdx are inspectable
 * for stratification + deviation-case clustering. Pure output; does NOT affect the eval or the report.
 */
export function writeFoldDump(report: AuqEvalReport, triples: AuqTriple[], path: string): void {
  const byId = new Map(triples.map((t) => [t.id, t]));
  const lines: string[] = [];
  for (const p of report.predictors) {
    for (const f of p.folds) {
      const t = byId.get(f.id);
      lines.push(
        JSON.stringify({
          predictor: p.name,
          id: f.id,
          situation: t?.situation ?? '',
          header: t?.header ?? '',
          options: t?.options ?? [],
          nOptions: f.nOptions,
          actualIdx: f.actualIdx,
          actualLabel: t?.options[f.actualIdx] ?? '',
          predictedIdx: f.predictedIdx,
          predictedLabel: t?.options[f.predictedIdx] ?? '',
          baselineIdx: f.baselineIdx,
          recommendedIdx: t?.recommendedIdx ?? null,
          deviation: f.deviation,
          hit: f.predictedIdx === f.actualIdx,
        }),
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function logSummary(report: AuqEvalReport, log: (l: string) => void): void {
  log(
    `[auq-fidelity] N=${report.n}, leave-one-out | baseline always-recommended=${pct(
      report.baselineAlwaysRecommended.accuracy,
    )} (${report.baselineAlwaysRecommended.correct}/${report.baselineAlwaysRecommended.n}) | 1/N random=${pct(
      report.baselineRandomExpected,
    )}`,
  );
  for (const p of report.predictors) {
    log(
      `  ${p.name.padEnd(28)} acc=${pct(p.metrics.accuracy)} (${p.metrics.correct}/${p.metrics.n})  deviation=${pct(
        p.metrics.deviationAccuracy,
      )} (${p.metrics.deviationCorrect}/${p.metrics.deviationN})`,
    );
  }
}

// --- report rendering ----------------------------------------------------------------

function renderTable(report: AuqEvalReport): string {
  const head = '| predictor | top-1 acc | correct | deviation acc | follow acc |';
  const sep = '|---|---|---|---|---|';
  const base = report.baselineAlwaysRecommended;
  const rows: string[] = [
    `| baseline:always-recommended/first | ${pct(base.accuracy)} | ${base.correct}/${base.n} | 0.0% (0/${base.n - base.correct}) | 100.0% (${base.correct}/${base.correct}) |`,
    `| baseline:1-of-N (random, analytic) | ${pct(report.baselineRandomExpected)} | - | - | - |`,
  ];
  for (const p of report.predictors) {
    if (p.name === 'baseline:always-recommended') continue;
    const m = p.metrics;
    rows.push(
      `| ${p.name} | ${pct(m.accuracy)} | ${m.correct}/${m.n} | ${pct(m.deviationAccuracy)} (${m.deviationCorrect}/${m.deviationN}) | ${pct(m.followAccuracy)} (${m.followCorrect}/${m.followN}) |`,
    );
  }
  return [head, sep, ...rows].join('\n');
}

function beatsLine(p: ChoicePredictorReport, baselineAcc: number): string {
  const verb = p.metrics.accuracy > baselineAcc ? 'BEATS' : 'does NOT beat';
  return `- ${p.name} top-1 = ${pct(p.metrics.accuracy)} -> ${verb} the always-recommended baseline (${pct(
    baselineAcc,
  )}). Deviation-case accuracy = ${pct(p.metrics.deviationAccuracy)} (${p.metrics.deviationCorrect}/${p.metrics.deviationN}).`;
}

/** The full AUQ forced-choice report markdown. Includes the explicit beats/does-not-beat verdicts. */
export function renderAuqReport(report: AuqEvalReport, generatedAt: string): string {
  const baselineAcc = report.baselineAlwaysRecommended.accuracy;
  const judges = report.predictors.filter((p) => p.name.startsWith('judge:'));
  const dist = report.optionCountDistribution;
  const distStr = Object.keys(dist)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => `${n}-option: ${dist[n]}`)
    .join(', ');

  const lines = [
    '# AUQ choice-prediction fidelity eval, report',
    '',
    `Generated: ${generatedAt}`,
    'Lane: AskUserQuestion forced choice (predict which option the owner picked). Scored SEPARATELY',
    'from the Soundwave up/down lane; never blended (roadmap invariant: two scores).',
    'Contract: `src/eval/fidelity/AUQ-CONTRACT.md`. Harness: `src/eval/fidelity/auq-*.ts` (matrix repo).',
    '',
    '## What this measures',
    '',
    'Given a question Claude put to the owner with a fixed option set, predict WHICH option he picked',
    'from his prior choosing behaviour. The always-recommended baseline is strong (Claude already',
    'encodes situation reasoning into its recommendation), so beating it is the real test. The signal',
    'lives in the deviation cases where the owner did NOT take the recommendation.',
    '',
    '## Setup',
    '',
    `- N = ${report.n} clean forced-choice triples (leave-one-out; ${report.n} folds).`,
    `- Option-count distribution: ${distStr}.`,
    '- Situation = question text (+ header). Leak-free by construction (situation never contains an option label).',
    `- Retrieval: held-out situation's stored ${EMBED_DIM}-dim embedding (key \`${AUQ_SITUATION_MODEL}\`) -> L2 nearest prior picks, used as the judge's few-shot examples.`,
    '- Primary metric: top-1 accuracy. Deviation-case accuracy reported separately as the high-value signal.',
    '',
    '## Baselines (the bar to beat)',
    '',
    `- always-pick-recommended/first = ${pct(baselineAcc)} (${report.baselineAlwaysRecommended.correct}/${report.baselineAlwaysRecommended.n}).`,
    `- 1/N random (analytic, mean 1/option-count) = ${pct(report.baselineRandomExpected)}.`,
    '',
    '## Results',
    '',
    renderTable(report),
    '',
    '## Reading',
    '',
    judges.length > 0
      ? judges.map((p) => beatsLine(p, baselineAcc)).join('\n')
      : '- Gemini judge: NOT run in this pass (gated; needs GEMINI_API_KEY + a /chub-verified model id).',
    '',
    '## kNN design decision (per the goal card Assumptions)',
    '',
    "- A standalone local kNN predictor was DROPPED: option sets vary per question, so a neighbour's",
    '  picked LABEL does not exist in the held-out item\'s option set, and a "deviation" has no concrete',
    "  target. The situation embedding instead feeds the JUDGE's few-shot retrieval. The kNN contribution",
    '  is therefore measured as `judge:gemini-zeroshot` vs `judge:gemini-knn@k` (retrieval on/off).',
    '',
    '## Caveats (mandatory)',
    '',
    '- **Narrow facet.** This is the owner-via-Claude forced-choice taste, not general decision-making.',
    `- **Strong baseline.** always-recommended = ${pct(baselineAcc)} already encodes situation reasoning;`,
    '  a small top-1 lift over it can still be meaningful if it is concentrated in the deviation cases.',
    "- **Self-questions.** These are Claude's questions capturing the owner's picks, so the eval tests his",
    '  decision preference given a frame Claude chose, not free-form decisions.',
    '',
  ];
  return lines.join('\n');
}

// --- CLI -----------------------------------------------------------------------------

interface CliArgs {
  phase: 'extract' | 'embed' | 'eval';
  dbPath: string;
  limit?: number;
  judge: boolean;
  judgeModel?: string;
  k: number;
  concurrency: number;
  out: string;
  foldDump: string;
  write: boolean;
}

/** Default per-fold JSONL path: the report path with its extension swapped to `.folds.jsonl`. */
export function deriveFoldDumpPath(out: string): string {
  return out.endsWith('.md') ? out.slice(0, -3) + '.folds.jsonl' : out + '.folds.jsonl';
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const phaseRaw = get('--phase');
  const phase = phaseRaw === 'extract' || phaseRaw === 'embed' ? phaseRaw : 'eval';
  const limitRaw = get('--limit');
  return {
    phase,
    dbPath: get('--db') ?? defaultDbPath(),
    limit: limitRaw ? Number(limitRaw) : undefined,
    judge: argv.includes('--judge'),
    judgeModel: get('--judge-model'),
    k: get('--k') ? Number(get('--k')) : 5,
    concurrency: get('--concurrency') ? Number(get('--concurrency')) : 1,
    out: get('--out') ?? `${homedir()}/notes/planning/2026-06-26/auq-choice-eval-report.md`,
    foldDump:
      get('--fold-dump') ??
      deriveFoldDumpPath(
        get('--out') ?? `${homedir()}/notes/planning/2026-06-26/auq-choice-eval-report.md`,
      ),
    write: !argv.includes('--no-write'),
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.phase === 'extract') {
    const db = openDb(args.dbPath); // read-write, applies schema idempotently
    try {
      const r = extractAndWrite(db);
      console.log(
        `[auq-extract] filesScanned=${r.filesScanned} cleanTriples=${r.cleanTriples} leakDropped=${r.leakDropped} written=${r.written}`,
      );
    } finally {
      db.close();
    }
    return 0;
  }

  if (args.phase === 'embed') {
    const db = openDb(args.dbPath);
    try {
      const r = await embedSituations(db, realEmbedder, {
        limit: args.limit,
        log: (l) => console.log(l),
      });
      console.log(
        `[auq-embed] embedded=${r.embedded} failed=${r.failed} pendingBefore=${r.pending}`,
      );
    } finally {
      db.close();
    }
    return 0;
  }

  // eval (read-only)
  const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
  try {
    let judge: ChoiceJudge | undefined;
    if (args.judge) {
      if (!args.judgeModel) {
        console.error(
          '--judge requires --judge-model <id> (verify the Gemini model id via /chub first)',
        );
        return 2;
      }
      judge = withJudgeRetry(realGeminiChoiceJudge({ model: args.judgeModel }));
    }
    const res = await runAuqFidelity({
      db,
      judge,
      k: args.k,
      concurrency: args.concurrency,
      foldDumpPath: args.write ? args.foldDump : undefined,
    });
    if (res.halted) return 1;
    if (args.write && res.report) {
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
      const md = renderAuqReport(res.report, stamp);
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, md, 'utf-8');
      console.log(`[auq-fidelity] report written to ${args.out}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`[auq-fidelity] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

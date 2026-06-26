// Matrix v1 decision-fidelity eval: run entrypoint + report renderer.
// See ./CONTRACT.md. Opens the warehouse READ-ONLY (never mutates the 4.7GB store), loads the
// labeled Soundwave grades, runs the kNN predictor + both baselines locally, optionally runs the
// gated Gemini judge, scores everything over leave-one-out, and writes the skeleton report.
//
// Kill gate (honored): if usable grades < MIN_GRADES or retrieval has no context, print
// "[HALT] data not ready" with the count and write nothing.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadSoundwaveGrades, type Grade } from './dataset.js';
import {
  knnPredictor,
  majorityClassBaseline,
  perDomainBaseline,
  llmJudgePredictor,
  type Judge,
} from './predictors.js';
import { runFidelityEval, type EvalReport, type PredictorReport } from './harness.js';
import { realGeminiJudge } from './judge.js';

/** Plan kill-gate floor: below this a held-out split is not meaningful. */
export const MIN_GRADES = 20;

export interface RunOptions {
  dbPath?: string;
  /** Open handle injection (tests). When set, dbPath ignored and the caller owns close(). */
  db?: Database.Database;
  /** kNN neighbor counts to evaluate. Default [3, 5, 7]. */
  kValues?: number[];
  /** Inject a Judge to include the LLM-judge predictor (real run wires realGeminiJudge). */
  judge?: Judge;
  /** kNN-retrieval size for the judge's few-shot examples. Default 5. */
  judgeK?: number;
  log?: (line: string) => void;
}

export interface RunResult {
  halted: boolean;
  reason?: string;
  grades: number;
  report?: EvalReport;
}

/** Open the warehouse read-only. No schema apply, no vec extension (kNN is in-memory over stored vectors). */
function openReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/**
 * Run the full eval. Returns the scored report (or a halt). Does NOT write a file; callers that
 * want the markdown call renderReport + write it (the CLI below does).
 */
export async function runFidelity(opts: RunOptions = {}): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const ownsDb = opts.db === undefined;
  const db = opts.db ?? openReadonly(opts.dbPath ?? defaultDbPath());

  try {
    const grades = loadSoundwaveGrades(db);
    if (grades.length < MIN_GRADES) {
      const reason = `[HALT] data not ready: ${grades.length} usable graded rows (< ${MIN_GRADES}); needs more grades / Phase 4`;
      log(reason);
      return { halted: true, reason, grades: grades.length };
    }

    const kValues = opts.kValues ?? [3, 5, 7];
    const predictors = [
      { name: 'baseline:majority-class', predictor: majorityClassBaseline },
      { name: 'baseline:per-domain', predictor: perDomainBaseline },
      ...kValues.map((k) => ({ name: `knn@${k}`, predictor: knnPredictor(k) })),
    ];
    if (opts.judge) {
      predictors.push({
        name: 'llm-judge:gemini',
        predictor: llmJudgePredictor(opts.judge, opts.judgeK ?? 5),
      });
    }

    const report = await runFidelityEval(grades, predictors);
    logSummary(report, log);
    return { halted: false, grades: grades.length, report };
  } finally {
    if (ownsDb) db.close();
  }
}

function defaultDbPath(): string {
  return `${homedir()}/projects/matrix/store/matrix.db`;
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function logSummary(report: EvalReport, log: (l: string) => void): void {
  log(`[fidelity] N=${report.n} (${report.upCount} up / ${report.downCount} down), leave-one-out`);
  for (const p of report.predictors) {
    log(
      `  ${p.name.padEnd(24)} acc=${pct(p.metrics.accuracy)} (${p.metrics.correct}/${p.metrics.n})  brier=${p.metrics.brier.toFixed(3)}`,
    );
  }
}

// --- report rendering ----------------------------------------------------------------

function renderTable(predictors: PredictorReport[]): string {
  const head = '| predictor | accuracy | correct | Brier | TP | FP | TN | FN |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const rows = predictors.map((p) => {
    const m = p.metrics;
    return `| ${p.name} | ${pct(m.accuracy)} | ${m.correct}/${m.n} | ${m.brier.toFixed(3)} | ${m.truePos} | ${m.falsePos} | ${m.trueNeg} | ${m.falseNeg} |`;
  });
  return [head, sep, ...rows].join('\n');
}

/** The full skeleton report markdown (subtask 10). Includes the mandatory narrow-signal caveat. */
export function renderReport(report: EvalReport, generatedAt: string): string {
  const baselineAcc =
    report.predictors.find((p) => p.name === 'baseline:majority-class')?.metrics.accuracy ?? 0;
  const bestKnn = report.predictors
    .filter((p) => p.name.startsWith('knn@'))
    .sort((a, b) => b.metrics.accuracy - a.metrics.accuracy)[0];
  const judge = report.predictors.find((p) => p.name.startsWith('llm-judge'));

  const lines = [
    '# v1 Decision-Fidelity Eval, Skeleton Report',
    '',
    `Generated: ${generatedAt}`,
    'Track: Soundwave -> Matrix Phase 3 / beta-digital-longevity v1 (the "whole game").',
    'Contract: `src/eval/fidelity/CONTRACT.md`. Harness: `src/eval/fidelity/` (matrix repo).',
    '',
    '## What this measures (and does not)',
    '',
    "DECISION fidelity ONLY, on one narrow lane: can the warehouse predict the owner's thumbs",
    'up/down on a newly discovered article from his prior grading behavior? Voice fidelity is',
    'OUT OF SCOPE here and is NOT computed and NOT averaged in (roadmap invariant: two scores,',
    'never blended). This is a MECHANISM PROOF, not a trustworthy general-fidelity number.',
    '',
    '## Setup',
    '',
    `- N = ${report.n} labeled grades (${report.upCount} up / ${report.downCount} down; approval rate ${pct(report.upCount / report.n)}).`,
    '- Split: leave-one-out (N folds; each holds out 1, context = the other N-1). No verdict/notes leakage.',
    "- Retrieval: held-out item's stored 3072-dim embedding -> L2 nearest prior grades (no re-embed).",
    '- Primary metric: accuracy. Calibration: Brier score (lower better).',
    '',
    '## Results',
    '',
    renderTable(report.predictors),
    '',
    '## Reading',
    '',
    `- Baseline to beat (majority-class) accuracy = ${pct(baselineAcc)}. A predictor only shows signal if it clears this.`,
    bestKnn
      ? `- Best kNN (${bestKnn.name}) accuracy = ${pct(bestKnn.metrics.accuracy)}, Brier ${bestKnn.metrics.brier.toFixed(3)} -> ${bestKnn.metrics.accuracy > baselineAcc ? 'beats' : 'does NOT beat'} the majority prior.`
      : '- kNN: not run.',
    judge
      ? `- Gemini LLM-judge accuracy = ${pct(judge.metrics.accuracy)}, Brier ${judge.metrics.brier.toFixed(3)} -> ${judge.metrics.accuracy > baselineAcc ? 'beats' : 'does NOT beat'} the majority prior.`
      : '- Gemini LLM-judge: NOT run in this pass (gated; needs GEMINI_API_KEY + a /chub-verified model id).',
    '',
    '## Caveats (mandatory)',
    '',
    `- **Narrow facet.** This is AI-article taste, not general decision-making. Do not read it as the owner's general decision fidelity.`,
    `- **Tiny N.** ${report.n} folds, ${report.downCount} of the minority class. One flipped prediction moves accuracy ~${(100 / report.n).toFixed(1)} points. Read counts, not just percentages.`,
    '- **Per-domain baseline degrades.** 4 of 8 domains are singletons; for those the per-domain prior falls back to the global prior, so it is barely distinct from majority-class.',
    '- **kNN can echo the prior.** If embeddings cluster by topic not taste, kNN reproduces the majority. If kNN ~= baseline, the warehouse adds nothing on THIS lane yet, a real finding, not hidden.',
    '- **Next.** Phase 4 (decision/outcome ETL) enlarges the labeled set; re-run this same harness to get a number worth trusting.',
    '',
  ];
  return lines.join('\n');
}

// --- CLI -----------------------------------------------------------------------------

interface CliArgs {
  judge: boolean;
  judgeModel?: string;
  out: string;
  dbPath?: string;
  write: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    judge: argv.includes('--judge'),
    judgeModel: get('--judge-model'),
    dbPath: get('--db'),
    out:
      get('--out') ?? `${homedir()}/notes/planning/2026-06-26/fidelity-eval-v1-skeleton-report.md`,
    write: !argv.includes('--no-write'),
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  let judge: Judge | undefined;
  if (args.judge) {
    if (!args.judgeModel) {
      console.error(
        '--judge requires --judge-model <id> (verify the Gemini model id via /chub first)',
      );
      process.exit(2);
    }
    judge = realGeminiJudge({ model: args.judgeModel });
  }
  runFidelity({ dbPath: args.dbPath, judge })
    .then((res) => {
      if (res.halted) {
        process.exitCode = 1;
        return;
      }
      if (args.write && res.report) {
        // Timestamp stamped here (not in scripts, which forbid Date.now in some runtimes).
        const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
        const md = renderReport(res.report, stamp);
        mkdirSync(dirname(args.out), { recursive: true });
        writeFileSync(args.out, md, 'utf-8');
        console.log(`[fidelity] report written to ${args.out}`);
      }
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      console.error(`[fidelity] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

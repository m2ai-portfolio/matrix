// Matrix AUQ lane: additive kNN@k sweep runner (diagnostics only, not part of the canonical eval).
// See ./AUQ-CONTRACT.md and Q-20260628-0008. REUSES the existing harness (loadAuqTriples,
// runChoicePredictorLOO, scoreChoice, judgePredictor, realGeminiChoiceJudge); it does not redefine
// the eval. For each k it runs the Gemini judge once over the same LOO folds, appends every fold to a
// combined JSONL (same row shape as auq-run.ts:writeFoldDump), and writes a per-k metrics summary.
//
// Cost: each k is ~N (=423) Gemini judge calls. Pass --ks to limit which k values run so already-run
// k values (e.g. k=0,5 from the canonical auq-run dump) are not repeated. --limit caps triples for a
// prove-one smoke. The judge is wrapped with bounded retry+backoff so a transient 429/5xx over a long
// run does not abort the whole sweep.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { AUQ_SITUATION_MODEL, loadAuqTriples, type AuqTriple } from './auq-dataset.js';
import {
  judgePredictor,
  alwaysRecommendedPredictor,
  type ChoiceJudge,
  type ChoiceJudgeInput,
  type ChoiceJudgeOutput,
} from './auq-predictors.js';
import { realGeminiChoiceJudge } from './auq-judge.js';
import {
  runChoicePredictorLOO,
  scoreChoice,
  alwaysRecommendedAccuracy,
  expectedRandomAccuracy,
  optionCountDistribution,
  type ChoiceFoldResult,
  type ChoiceMetrics,
} from './auq-harness.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a judge with bounded exponential backoff so one transient error OR a prose-only (no-JSON)
 * reply cannot abort a long sweep. After the final attempt it degrades to the first option (index 0)
 * rather than throwing, matching the eval's existing clampIdx fallback for unparseable replies.
 */
export function withRetry(judge: ChoiceJudge, attempts = 4, baseMs = 800): ChoiceJudge {
  return async (input: ChoiceJudgeInput): Promise<ChoiceJudgeOutput> => {
    for (let a = 0; a < attempts; a++) {
      try {
        return await judge(input);
      } catch {
        if (a < attempts - 1) await sleep(baseMs * 2 ** a + Math.random() * 250);
      }
    }
    return { chosenIdx: 0 };
  };
}

function dumpRow(predictor: string, f: ChoiceFoldResult, t: AuqTriple | undefined): string {
  return JSON.stringify({
    predictor,
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
  });
}

interface KResult {
  k: number;
  metrics: ChoiceMetrics;
}

interface SweepArgs {
  dbPath: string;
  model: string;
  judgeModel: string;
  ks: number[];
  concurrency: number;
  limit?: number;
  jsonl: string;
  summary: string;
  includeBaseline: boolean;
}

function parseSweepArgs(argv: string[]): SweepArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = `${homedir()}/notes/planning`;
  return {
    dbPath: get('--db') ?? `${homedir()}/projects/matrix/store/matrix.db`,
    model: get('--model') ?? AUQ_SITUATION_MODEL,
    judgeModel: get('--judge-model') ?? '',
    ks: (get('--ks') ?? '0,1,2,3,5,10').split(',').map((s) => Number(s.trim())),
    concurrency: get('--concurrency') ? Number(get('--concurrency')) : 6,
    limit: get('--limit') ? Number(get('--limit')) : undefined,
    jsonl: get('--jsonl') ?? `${outDir}/auq-sweep.folds.jsonl`,
    summary: get('--summary') ?? `${outDir}/auq-sweep.summary.json`,
    includeBaseline: !argv.includes('--no-baseline'),
  };
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

async function main(argv: string[]): Promise<number> {
  const args = parseSweepArgs(argv);
  if (!args.judgeModel) {
    console.error('--judge-model <id> is required (verify the Gemini model id via /chub first).');
    return 2;
  }
  const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
  try {
    let triples = loadAuqTriples(db, args.model);
    if (args.limit) triples = triples.slice(0, args.limit);
    console.log(`[auq-sweep] N=${triples.length} triples; ks=${args.ks.join(',')}`);

    const base = alwaysRecommendedAccuracy(triples);
    const rand = expectedRandomAccuracy(triples);
    const dist = optionCountDistribution(triples);
    const byId = new Map(triples.map((t) => [t.id, t]));

    mkdirSync(dirname(args.jsonl), { recursive: true });
    writeFileSync(args.jsonl, '', 'utf-8'); // truncate

    // Baseline folds (no network) — handy to have the same dump carry the baseline rows.
    if (args.includeBaseline) {
      const baseFolds = await runChoicePredictorLOO(triples, alwaysRecommendedPredictor);
      const baseLines = baseFolds
        .map((f) => dumpRow('baseline:always-recommended', f, byId.get(f.id)))
        .join('\n');
      appendFileSync(args.jsonl, baseLines + '\n', 'utf-8');
    }

    const judge = withRetry(realGeminiChoiceJudge({ model: args.judgeModel }));
    const results: KResult[] = [];
    for (const k of args.ks) {
      const name = k === 0 ? 'judge:gemini-zeroshot' : `judge:gemini-knn@${k}`;
      const t0 = Date.now();
      const folds = await runChoicePredictorLOO(triples, judgePredictor(judge, k), {
        concurrency: args.concurrency,
        log: (done, total) => {
          if (done % 100 === 0 || done === total)
            console.log(`[auq-sweep] ${name}: ${done}/${total}`);
        },
      });
      const metrics = scoreChoice(folds);
      results.push({ k, metrics });
      const lines = folds.map((f) => dumpRow(name, f, byId.get(f.id))).join('\n');
      appendFileSync(args.jsonl, lines + '\n', 'utf-8');
      console.log(
        `[auq-sweep] ${name} acc=${pct(metrics.accuracy)} dev=${pct(
          metrics.deviationAccuracy,
        )} follow=${pct(metrics.followAccuracy)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      judgeModel: args.judgeModel,
      n: triples.length,
      optionCountDistribution: dist,
      baselineAlwaysRecommended: base,
      baselineRandomExpected: rand,
      ks: results.map((r) => ({
        k: r.k,
        accuracy: r.metrics.accuracy,
        correct: r.metrics.correct,
        n: r.metrics.n,
        deviationAccuracy: r.metrics.deviationAccuracy,
        deviationCorrect: r.metrics.deviationCorrect,
        deviationN: r.metrics.deviationN,
        followAccuracy: r.metrics.followAccuracy,
        followCorrect: r.metrics.followCorrect,
        followN: r.metrics.followN,
      })),
    };
    mkdirSync(dirname(args.summary), { recursive: true });
    writeFileSync(args.summary, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`[auq-sweep] summary -> ${args.summary}`);
    console.log(`[auq-sweep] folds   -> ${args.jsonl}`);
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
      console.error(`[auq-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

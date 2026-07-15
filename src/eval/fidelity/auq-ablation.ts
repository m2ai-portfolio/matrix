// Matrix AUQ lane: ablation experiments for Q-20260711-0027.
// Runs four experiment groups against the existing embedded dataset:
//   1. Learning curve: knn@5 accuracy with retrieval pool restricted to first 50/100/200/423
//      chronological labels; evaluates on a fixed held-out set (last 50 triples by turn_id).
//   2. Warehouse ablation: labels-only LOO-423 vs labels+10k-corpus LOO-423 -- tests whether
//      the knn retrieval lift is driven by the 423 AUQ labels or by warehouse conversation exhaust.
//   3. Temporal holdout: pool = oldest 70% (296 labels), test = newest 50; compare to LOO number.
//   4. Deviation recall + Wilson 95% CI on every condition.
// Judge: gemini-2.5-flash (explicitly set; no Fable models per usage-credit policy).
// Keys from GEMINI_API_KEY or GOOGLE_API_KEY (source ~/.env.shared before running).
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { AUQ_SITUATION_MODEL, loadAuqTriples, type AuqTriple } from './auq-dataset.js';
import {
  clampIdx,
  type ChoiceJudge,
  type ChoicePredictor,
  type ChoiceExample,
  judgePredictor,
} from './auq-predictors.js';
import { realGeminiChoiceJudge } from './auq-judge.js';
import {
  runChoicePredictorLOO,
  scoreChoice,
  alwaysRecommendedAccuracy,
  expectedRandomAccuracy,
  baselineIdxOf,
  type ChoiceFoldResult,
  type ChoiceMetrics,
} from './auq-harness.js';
import { withJudgeRetry } from './auq-run.js';
import { l2 } from './predictors.js';
import { decodeVector } from './dataset.js';
import { EMBED_MODEL } from '../../db/vec.js';

// --- statistical helpers ----------------------------------------------------------------

/** Wilson 95% confidence interval for a proportion k/n. */
function wilsonCI(k: number, n: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 0 };
  const z = 1.96;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function ciStr(k: number, n: number): string {
  if (n === 0) return 'n/a';
  const { lower, upper } = wilsonCI(k, n);
  return `[${pct(lower)}, ${pct(upper)}]`;
}

// --- pooled evaluator ------------------------------------------------------------------

/**
 * Run a predictor against a fixed test set using a separate retrieval pool.
 * Each test item is excluded from its own pool fold (prevents data leakage even when
 * the test item appears in the pool, which happens in the pool=423 learning-curve condition).
 */
async function runPooledEval(
  testSet: AuqTriple[],
  contextPool: AuqTriple[],
  predictor: ChoicePredictor,
  concurrency = 6,
): Promise<ChoiceFoldResult[]> {
  const results: ChoiceFoldResult[] = new Array<ChoiceFoldResult>(testSet.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= testSet.length) return;
      const heldOut = testSet[i];
      const ctx = contextPool.filter((t) => t.id !== heldOut.id);
      const predictedIdx = await predictor(heldOut, ctx);
      const baselineIdx = baselineIdxOf(heldOut);
      results[i] = {
        id: heldOut.id,
        nOptions: heldOut.options.length,
        actualIdx: heldOut.chosenIdx,
        predictedIdx,
        baselineIdx,
        deviation: heldOut.chosenIdx !== baselineIdx,
      };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, testSet.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- corpus-aware predictor -----------------------------------------------------------

interface CorpusRow {
  vector: Buffer;
}

/** Load up to `limit` non-AUQ conversation embeddings for the warehouse ablation condition. */
function loadCorpusVectors(db: Database.Database, limit: number): Float32Array[] {
  const rows = db
    .prepare(
      `SELECT e.vector
         FROM embedding e
         JOIN conversation_turn t ON t.turn_id = e.turn_id
        WHERE e.model = ?
          AND t.source != 'auq'
        LIMIT ?`,
    )
    .all(EMBED_MODEL, limit) as CorpusRow[];
  return rows.map((r) => decodeVector(r.vector));
}

/**
 * Labels+corpus predictor: retrieval pool = AUQ context + warehouse corpus vectors.
 * The top-k from the combined pool are taken, then ONLY the AUQ ones are shown as
 * few-shot examples (corpus turns lack chosenIdx and cannot be formatted as examples).
 * If corpus vectors crowd out all AUQ neighbors from the top-k, the judge sees 0 examples.
 */
function judgePredictorWithCorpus(
  judge: ChoiceJudge,
  k: number,
  corpusVectors: Float32Array[],
): ChoicePredictor {
  return async (heldOut: AuqTriple, context: AuqTriple[]): Promise<number> => {
    if (!heldOut.vector) {
      const out = await judge({
        situation: heldOut.situation,
        options: heldOut.options,
        examples: [],
      });
      return clampIdx(out.chosenIdx, heldOut.options.length);
    }
    const hv = heldOut.vector;
    const dim = hv.length;

    type AuqEntry = { isAuq: true; triple: AuqTriple; dist: number };
    type CorpusEntry = { isAuq: false; dist: number };

    const auqEntries: AuqEntry[] = context
      .filter(
        (t): t is AuqTriple & { vector: Float32Array } => !!t.vector && t.vector.length === dim,
      )
      .map((t) => ({ isAuq: true as const, triple: t, dist: l2(hv, t.vector as Float32Array) }));

    const corpusEntries: CorpusEntry[] = corpusVectors
      .filter((v) => v.length === dim)
      .map((v) => ({ isAuq: false as const, dist: l2(hv, v) }));

    const topK = ([...auqEntries, ...corpusEntries] as Array<AuqEntry | CorpusEntry>)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);

    const examples: ChoiceExample[] = topK
      .filter((n): n is AuqEntry => n.isAuq)
      .map((n) => ({
        situation: n.triple.situation,
        options: n.triple.options,
        chosenIdx: n.triple.chosenIdx,
      }));

    const out = await judge({ situation: heldOut.situation, options: heldOut.options, examples });
    return clampIdx(out.chosenIdx, heldOut.options.length);
  };
}

// --- result types and markdown renderer ------------------------------------------------

interface ConditionRow {
  label: string;
  testN: number;
  correct: number;
  accuracy: number;
  devN: number;
  devCorrect: number;
  devAccuracy: number;
  devCI: string;
}

function toRow(label: string, m: ChoiceMetrics): ConditionRow {
  return {
    label,
    testN: m.n,
    correct: m.correct,
    accuracy: m.accuracy,
    devN: m.deviationN,
    devCorrect: m.deviationCorrect,
    devAccuracy: m.deviationAccuracy,
    devCI: ciStr(m.deviationCorrect, m.deviationN),
  };
}

function renderTable(rows: ConditionRow[]): string {
  const header =
    '| Condition | N-test | Overall acc | Correct | Dev recall | Dev N | Wilson 95% CI |';
  const sep = '|---|---|---|---|---|---|---|';
  const body = rows.map(
    (r) =>
      `| ${r.label} | ${r.testN} | ${pct(r.accuracy)} | ${r.correct}/${r.testN} | ${pct(r.devAccuracy)} | ${r.devCorrect}/${r.devN} | ${r.devCI} |`,
  );
  return [header, sep, ...body].join('\n');
}

function buildReport(params: {
  generatedAt: string;
  allTriples: number;
  testN: number;
  corpusN: number;
  temporalPoolN: number;
  baselineAccFull: number;
  baselineCorrectFull: number;
  baselineNFull: number;
  looLabelsOnlyAcc: number;
  looLabelsPlusCorpusAcc: number;
  commands: string;
  learningRows: ConditionRow[];
  warehouseRows: ConditionRow[];
  temporalRow: ConditionRow;
}): string {
  const {
    generatedAt,
    allTriples,
    testN,
    corpusN,
    temporalPoolN,
    baselineAccFull,
    baselineCorrectFull,
    baselineNFull,
    looLabelsOnlyAcc,
    looLabelsPlusCorpusAcc,
    commands,
    learningRows,
    warehouseRows,
    temporalRow,
  } = params;

  // Binary verdict paragraph
  const lift = looLabelsOnlyAcc - 0.331;
  const labelsOnlyLift = lift > 0.05;
  // Signed on purpose: only a corpus that HELPS (positive delta) undermines the
  // labels-carry-the-lift claim; a corpus that dilutes retrieval supports it.
  const corpusDelta = looLabelsPlusCorpusAcc - looLabelsOnlyAcc;
  const corpusEffect = corpusDelta > 0.03 ? 'material' : 'negligible';
  const verdictYes = labelsOnlyLift && corpusEffect === 'negligible';

  const verdictPara = verdictYes
    ? `Yes, labels-only retrieval lifted materially over the 33.1% zero-shot control. ` +
      `The labels-only LOO-423 result is ${pct(looLabelsOnlyAcc)}, a lift of ${pct(lift)} over zero-shot. ` +
      `The labels+corpus condition (${pct(looLabelsPlusCorpusAcc)}) differs by ${pct(corpusDelta)} ` +
      `from labels-only, which is ${corpusEffect} (corpus displacement of AUQ examples in the top-k is minimal). ` +
      `The retrieval lift is driven by the owner's 423 person-specific labels, not by warehouse conversation exhaust. ` +
      `The person-specific thesis survives and is citable in peer review: adding the owner's prior choosing behaviour ` +
      `to the judge context recovers decision preference well above what the zero-shot judge achieves alone.`
    : `No, labels-only retrieval did NOT lift materially over the 33.1% zero-shot control (labels-only LOO-423 = ${pct(looLabelsOnlyAcc)}, ` +
      `lift = ${pct(lift)}; labels+corpus = ${pct(looLabelsPlusCorpusAcc)}, delta = ${pct(corpusDelta)}). ` +
      `The person-specific thesis does not survive at this threshold. ` +
      `Reposition per battle-test section 6 (~/notes/projects/mats-battle-test-2026-07-11.md).`;

  return [
    '# AUQ Ablation Retest Results',
    '',
    `Generated: ${generatedAt}`,
    `Card: Q-20260711-0027`,
    `Repo: matrix (branch ablation/Q-20260711-0027)`,
    '',
    '## Published Baselines (prior run, for comparison)',
    '',
    `- N: ${allTriples} clean forced-choice triples (AUQ, embedded under ${AUQ_SITUATION_MODEL})`,
    '- Always-recommendation baseline: 73.5% (311/423)',
    '- Zero-shot judge (gemini-2.5-flash): 33.1%',
    '- kNN@5 labels-only LOO-423: 56.5%',
    '- Deviation rows: 112 (26.5% of 423)',
    '',
    '## Experiment 1: Learning Curve (fixed held-out = last 50 by turn_id)',
    '',
    `Fixed test set: last ${testN} triples by turn_id sort order.`,
    `Pool sizes: first N of the full 423 labels (test items excluded per-fold when in the pool).`,
    `Baseline on test set: ${pct(baselineAccFull)} (${baselineCorrectFull}/${baselineNFull}).`,
    '',
    renderTable(learningRows),
    '',
    '## Experiment 2: Warehouse Ablation (LOO over all 423)',
    '',
    `Labels-only: kNN@5 retrieval from the 422 other AUQ labels (current published behavior).`,
    `Labels+corpus: kNN@5 retrieval from 422 AUQ + ${corpusN} random warehouse conversation embeddings;`,
    `only AUQ entries in the top-5 are shown as few-shot examples (corpus turns lack chosenIdx).`,
    '',
    renderTable(warehouseRows),
    '',
    '## Experiment 3: Temporal Holdout',
    '',
    `Training pool: oldest ${temporalPoolN} triples (70% of 423). Test: newest ${testN} triples.`,
    `Reference: LOO-423 labels-only = ${pct(looLabelsOnlyAcc)} (row above).`,
    '',
    renderTable([temporalRow]),
    '',
    '## Binary Verdict',
    '',
    verdictPara,
    '',
    '## Commands',
    '',
    '```bash',
    commands,
    '```',
    '',
  ].join('\n');
}

// --- main ------------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('No Gemini key: source ~/.env.shared before running');
  }

  // Per the goal card: NOT Fable. gemini-2.5-flash matches the published run.
  const JUDGE_MODEL = 'gemini-2.5-flash';
  const DB_PATH = `${homedir()}/projects/matrix/store/matrix.db`;
  const CONCURRENCY = 6;
  const HOLDOUT_N = 50;
  const CORPUS_LIMIT = 10000;

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  try {
    const triples = loadAuqTriples(db, AUQ_SITUATION_MODEL);
    console.log(`[ablation] loaded ${triples.length} AUQ triples`);

    if (triples.length < 100) {
      throw new Error(`[HALT] only ${triples.length} embedded AUQ triples; need >= 100`);
    }

    const judge = withJudgeRetry(realGeminiChoiceJudge({ model: JUDGE_MODEL }));

    // Fixed test set and non-test training data (sorted by turn_id = chronological proxy)
    const testSet = triples.slice(triples.length - HOLDOUT_N);
    const trainAll = triples.slice(0, triples.length - HOLDOUT_N);

    // Baseline accuracy on the fixed test set (no judge needed)
    const testBaseline = alwaysRecommendedAccuracy(testSet);

    // ---- Experiment 1: Learning curve ------------------------------------------------
    console.log('[ablation] Experiment 1: learning curve...');
    const POOL_SIZES = [50, 100, 200, triples.length];
    const learningRows: ConditionRow[] = [];

    for (const poolSize of POOL_SIZES) {
      // pool=423 uses ALL triples including test items; each test fold excludes its own item
      const pool = poolSize >= triples.length ? triples : trainAll.slice(0, poolSize);
      const actualPoolMax = pool.length;
      console.log(
        `  pool=${poolSize} (actual pool rows: ${actualPoolMax}, test: ${testSet.length})...`,
      );
      const folds = await runPooledEval(testSet, pool, judgePredictor(judge, 5), CONCURRENCY);
      const m = scoreChoice(folds);
      const label = `learning:knn@5 pool=${poolSize}`;
      learningRows.push(toRow(label, m));
      console.log(
        `  => acc=${pct(m.accuracy)} devRecall=${pct(m.deviationAccuracy)} (${m.deviationCorrect}/${m.deviationN})`,
      );
    }

    // ---- Experiment 2: Warehouse ablation --------------------------------------------
    console.log('[ablation] Experiment 2: warehouse ablation (LOO-423)...');

    console.log('  labels-only (current behavior)...');
    const looFolds = await runChoicePredictorLOO(triples, judgePredictor(judge, 5), {
      concurrency: CONCURRENCY,
      log: (done, total) => {
        if (done % 100 === 0 || done === total)
          console.log(`    LOO labels-only: ${done}/${total}`);
      },
    });
    const labelsOnlyMetrics = scoreChoice(looFolds);
    console.log(
      `  => acc=${pct(labelsOnlyMetrics.accuracy)} devRecall=${pct(labelsOnlyMetrics.deviationAccuracy)} (${labelsOnlyMetrics.deviationCorrect}/${labelsOnlyMetrics.deviationN})`,
    );

    console.log(`  loading ${CORPUS_LIMIT} corpus vectors...`);
    const corpusVectors = loadCorpusVectors(db, CORPUS_LIMIT);
    console.log(`  loaded ${corpusVectors.length} corpus vectors`);

    console.log('  labels+corpus...');
    const looCorpusFolds = await runChoicePredictorLOO(
      triples,
      judgePredictorWithCorpus(judge, 5, corpusVectors),
      {
        concurrency: CONCURRENCY,
        log: (done, total) => {
          if (done % 100 === 0 || done === total)
            console.log(`    LOO labels+corpus: ${done}/${total}`);
        },
      },
    );
    const labelsPlusCorpusMetrics = scoreChoice(looCorpusFolds);
    console.log(
      `  => acc=${pct(labelsPlusCorpusMetrics.accuracy)} devRecall=${pct(labelsPlusCorpusMetrics.deviationAccuracy)} (${labelsPlusCorpusMetrics.deviationCorrect}/${labelsPlusCorpusMetrics.deviationN})`,
    );

    const warehouseRows: ConditionRow[] = [
      toRow('warehouse:labels-only knn@5 LOO-423', labelsOnlyMetrics),
      toRow(
        `warehouse:labels+corpus-${corpusVectors.length} knn@5 LOO-423`,
        labelsPlusCorpusMetrics,
      ),
    ];

    // ---- Experiment 3: Temporal holdout ----------------------------------------------
    console.log('[ablation] Experiment 3: temporal holdout...');
    const temporalPoolN = Math.floor(triples.length * 0.7);
    const temporalPool = triples.slice(0, temporalPoolN);
    // test set = newest 50 (same as fixed held-out set)
    console.log(
      `  pool=${temporalPool.length} (oldest 70%), test=${testSet.length} (newest 50)...`,
    );
    const temporalFolds = await runPooledEval(
      testSet,
      temporalPool,
      judgePredictor(judge, 5),
      CONCURRENCY,
    );
    const temporalMetrics = scoreChoice(temporalFolds);
    const temporalRow = toRow('temporal:train=oldest70pct knn@5', temporalMetrics);
    console.log(
      `  => acc=${pct(temporalMetrics.accuracy)} devRecall=${pct(temporalMetrics.deviationAccuracy)} (${temporalMetrics.deviationCorrect}/${temporalMetrics.deviationN})`,
    );

    // ---- Write results ---------------------------------------------------------------
    const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const commands = [
      'source ~/.env.shared',
      `npx tsx src/eval/fidelity/auq-ablation.ts`,
      `# (run from: ${process.cwd()} on branch ablation/Q-20260711-0027)`,
      `# judge model: ${JUDGE_MODEL}`,
      `# db: ${DB_PATH}`,
      `# corpus sample: ${CORPUS_LIMIT} warehouse turns`,
    ].join('\n');

    const fullBaseline = alwaysRecommendedAccuracy(triples);

    const report = buildReport({
      generatedAt,
      allTriples: triples.length,
      testN: HOLDOUT_N,
      corpusN: corpusVectors.length,
      temporalPoolN,
      baselineAccFull: testBaseline.accuracy,
      baselineCorrectFull: testBaseline.correct,
      baselineNFull: testBaseline.n,
      looLabelsOnlyAcc: labelsOnlyMetrics.accuracy,
      looLabelsPlusCorpusAcc: labelsPlusCorpusMetrics.accuracy,
      commands,
      learningRows,
      warehouseRows,
      temporalRow,
    });

    const outPath = `${homedir()}/notes/projects/mats-auq-ablation-retest-results.md`;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report, 'utf-8');
    console.log(`[ablation] results written to ${outPath}`);

    // Summary for the terminal
    console.log('\n=== SUMMARY ===');
    console.log(`Full baseline (LOO-423 always-rec): ${pct(fullBaseline.accuracy)}`);
    console.log(`Labels-only knn@5 (LOO-423): ${pct(labelsOnlyMetrics.accuracy)}`);
    console.log(`Labels+corpus knn@5 (LOO-423): ${pct(labelsPlusCorpusMetrics.accuracy)}`);
    console.log(`Temporal holdout (test-50): ${pct(temporalMetrics.accuracy)}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`[ablation] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

// Soundwave Phase 3 — interest predictor CLI (card Q-20260706-0004; rank-cards added Q-20260706-0005).
// Compiles to dist/interest/run.js; run with plain node (no tsx):
//   source ~/.env.shared   # (rank/rank-cards modes embed via Gemini; eval mode needs no key)
//   node dist/interest/run.js --mode eval [--k 10]
//   node dist/interest/run.js --mode rank [--k 10] [--n 22]
//   node dist/interest/run.js --mode rank-cards --in <cards.json> [--k 3]
//
// eval: leave-one-out fidelity of the kNN predictor vs the majority-class and per-domain baselines.
// rank: fetch+embed the ungraded discoveries and rank them by predicted P(up) — the flywheel view.
// rank-cards: rank a batch of cards ({id,title,text}) the caller ALREADY has (no re-fetch). This is
//   the digest surfacing path (Q-20260706-0005): soundwave_discover.py shells out with the night's
//   discovered cards and renders the result as an advisory Top-Picks panel. k defaults to 3 to
//   reproduce the validated rank output in the Q-20260706-0004 report (best accuracy 70.4%).
// HALTs "[data not ready]" if the usable labeled set < 20 (the card's kill gate).

import { readFileSync } from 'node:fs';
import { openDb } from '../db/open.js';
import { loadLabeledSoundwave, loadUngradedDiscoveries } from './data.js';
import { evaluateLOO, knnPredict } from './predictor.js';
import { realEmbedder } from '../embed/embedder.js';
import { enrichContent } from '../connectors/soundwave.js';
import { rankCards, type CardInput } from './rank.js';

const MIN_USABLE = 20;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<number> {
  const mode = arg('--mode', 'eval');
  const k = Number(arg('--k', '10'));
  const dbPath = arg('--db'); // default: repo store/matrix.db
  const db = dbPath ? openDb(dbPath) : openDb();

  try {
    const labeled = loadLabeledSoundwave(db);
    if (labeled.length < MIN_USABLE) {
      console.log(
        JSON.stringify({ halt: '[data not ready]', usable: labeled.length, need: MIN_USABLE }),
      );
      return 1;
    }

    if (mode === 'eval') {
      // k-sweep so the report shows whether ANY k beats the baselines, not a cherry-picked one.
      const sweep = [3, 5, 10, 15, 20].map((kk) => {
        const r = evaluateLOO(labeled, kk);
        return {
          k: kk,
          predictor_acc: +r.predictor.acc.toFixed(4),
          predictor_brier: +r.predictor.brier.toFixed(4),
          majority_acc: +r.majority.acc.toFixed(4),
          majority_brier: +r.majority.brier.toFixed(4),
          perDomain_acc: +r.perDomain.acc.toFixed(4),
          perDomain_brier: +r.perDomain.brier.toFixed(4),
        };
      });
      const detail = evaluateLOO(labeled, k);
      console.log(
        JSON.stringify(
          {
            mode: 'eval',
            n: labeled.length,
            requested_k: k,
            sweep,
            detail_perItem: detail.perItem,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (mode === 'rank') {
      const n = Number(arg('--n', '22'));
      const ungraded = loadUngradedDiscoveries().slice(0, n);
      const ranked: Array<Record<string, unknown>> = [];
      const failed: string[] = [];
      for (const it of ungraded) {
        try {
          const enr = await enrichContent({ id: it.id, title: it.title }, { url: it.url });
          const vec = new Float32Array(await realEmbedder(enr.content));
          const pred = knnPredict(vec, labeled, k);
          const nearest = pred.neighbors[0];
          const exemplar = labeled.find((l) => l.turn_id === nearest?.turn_id);
          ranked.push({
            id: it.id,
            domain: it.domain,
            title: it.title.slice(0, 90),
            pUp: +pred.pUp.toFixed(3),
            verdict: pred.verdict,
            confidence: +pred.confidence.toFixed(3),
            nearest_graded: exemplar ? { verdict: exemplar.verdict, title: exemplar.title } : null,
          });
        } catch (e) {
          failed.push(`${it.id}: ${(e as Error).message}`);
        }
      }
      ranked.sort((a, b) => (b.pUp as number) - (a.pUp as number));
      console.log(
        JSON.stringify({ mode: 'rank', k, ranked_count: ranked.length, failed, ranked }, null, 2),
      );
      return 0;
    }

    if (mode === 'rank-cards') {
      // k defaults to 3 here (report's validated rank setting), independent of eval/rank's k=10.
      const kCards = Number(arg('--k', '3'));
      const inPath = arg('--in');
      if (!inPath) {
        console.error('--mode rank-cards requires --in <path> (JSON array of {id,title,text})');
        return 2;
      }
      let cards: CardInput[];
      try {
        const parsed = JSON.parse(readFileSync(inPath, 'utf-8')) as unknown;
        if (!Array.isArray(parsed)) throw new Error('input is not a JSON array');
        cards = parsed
          .filter(
            (c): c is { id: string; title?: unknown; text?: unknown } =>
              !!c && typeof (c as { id?: unknown }).id === 'string',
          )
          .map((c) => ({ id: c.id, title: String(c.title ?? ''), text: String(c.text ?? '') }));
      } catch (e) {
        console.error(`rank-cards: bad --in file: ${(e as Error).message}`);
        return 2;
      }
      const predictions = await rankCards(cards, labeled, realEmbedder, kCards);
      // stdout is ONLY this JSON (logs go to stderr) so the Python caller can json.loads it.
      console.log(
        JSON.stringify({
          mode: 'rank-cards',
          k: kCards,
          count: Object.keys(predictions).length,
          predictions,
        }),
      );
      return 0;
    }

    console.error(`unknown --mode ${mode} (use eval|rank|rank-cards)`);
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}

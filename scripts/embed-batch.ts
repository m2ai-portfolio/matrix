// Matrix Phase 1 — GATED live embed run (one-end-to-end-then-scale).
// Runs the REAL embedder (EMBED_MODEL via DeepInfra; see src/embed/embedder.ts). Invoke with:
//   source ~/.env.shared && npx tsx scripts/embed-batch.ts [limit|all] [concurrency]
// Examples: `... 100 1` (gated batch), `... all 16` (full backfill, 16-way pool).
// Requires DEEPINFRA_API_KEY (source ~/.env.shared). The old @google/genai notes no longer
// apply to the embed path (the eval judges still use Gemini keys separately).

import { openDb } from '../src/db/open.js';
import { ingestCcos } from '../src/connectors/ccos.js';
import { runEmbedWorker, findUnembedded } from '../src/embed/worker.js';
import { realEmbedder } from '../src/embed/embedder.js';
import type { Embedder } from '../src/embed/embedder.js';
import { semanticSearch } from '../src/search/semantic.js';
import { EMBED_MODEL } from '../src/db/vec.js';

const CCOS_DB = '/opt/claudeclaw-os/store/claudeclaw.db';
const arg = process.argv[2] ?? '100';
const LIMIT: number | undefined = arg === 'all' ? undefined : Number(arg);
const CONCURRENCY = Number(process.argv[3] ?? 1);

/** Wrap an embedder with exponential backoff so a transient 429/network blip retries instead of
 * aborting the whole pool. Permanent failures still surface after the final attempt. */
function withRetry(e: Embedder, tries = 5): Embedder {
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

function count(db: ReturnType<typeof openDb>, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

const db = openDb(); // default <repo>/store/matrix.db

console.log('=== BEFORE ===');
console.log('conversation_turn:', count(db, 'SELECT COUNT(*) c FROM conversation_turn'));
console.log('embedding:', count(db, 'SELECT COUNT(*) c FROM embedding'));
console.log('unembedded:', findUnembedded(db, EMBED_MODEL).length);
console.log(`config: limit=${LIMIT ?? 'all'} concurrency=${CONCURRENCY}`);

console.log('\n=== STEP 1: CCOS read-only pull (idempotent; loads existing vectors) ===');
console.log(JSON.stringify(ingestCcos(db, CCOS_DB)));

console.log(`\n=== STEP 2: embed via REAL ${EMBED_MODEL} ===`);
const t0 = Date.now();
let last = 0;
let res: { embedded: number; skipped: number };
try {
  res = await runEmbedWorker(db, {
    embedder: withRetry(realEmbedder),
    limit: LIMIT,
    concurrency: CONCURRENCY,
    onProgress: (n) => {
      if (n - last >= 2000) {
        last = n;
        const rate = n / ((Date.now() - t0) / 1000);
        console.log(`  ...${n} embedded (${rate.toFixed(1)}/s)`);
      }
    },
  });
} catch (e) {
  console.error('WORKER THREW (resumable — committed rows persist; re-run to continue):');
  console.error((e as Error).message);
  res = { embedded: -1, skipped: -1 };
}
const ms = Date.now() - t0;
console.log('result:', JSON.stringify(res), `elapsed_s=${(ms / 1000).toFixed(1)}`);

console.log('\n=== STEP 3: validate ===');
console.log('embedding rows:', count(db, 'SELECT COUNT(*) c FROM embedding'));
console.log(
  'distinct dims:',
  JSON.stringify(db.prepare('SELECT DISTINCT dim FROM embedding').all()),
);
console.log(
  'embedded by source:',
  JSON.stringify(
    db
      .prepare(
        `SELECT t.source AS source, COUNT(*) AS c
           FROM embedding e JOIN conversation_turn t ON t.turn_id = e.turn_id
          GROUP BY t.source`,
      )
      .all(),
  ),
);

console.log('\n=== STEP 4: one cross-source semantic search ===');
const hits = await semanticSearch(db, 'second brain warehouse architecture decision', {
  embedder: withRetry(realEmbedder),
  k: 5,
});
for (const h of hits) {
  console.log(
    `[${h.source}] ${h.score.toFixed(4)}  ${h.content.slice(0, 90).replace(/\s+/g, ' ')}`,
  );
}

db.close();
console.log('\nDONE.');

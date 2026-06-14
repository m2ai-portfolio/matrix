// Matrix Phase 1 — post-backfill validation. Read-only on the warehouse.
import { openDb } from '../src/db/open.js';
import { initVec, vecCount } from '../src/db/vec.js';
import { realEmbedder } from '../src/embed/embedder.js';
import { semanticSearch } from '../src/search/semantic.js';

const db = openDb();
initVec(db); // load the sqlite-vec extension into this connection before querying vec0
const emb = (db.prepare('SELECT COUNT(*) c FROM embedding').get() as { c: number }).c;
const vc = vecCount(db);
console.log(
  `embedding_rows=${emb}  vec_index_rows=${vc}  parity=${vc === emb ? 'OK' : 'MISMATCH'}`,
);

const hits = await semanticSearch(
  db,
  'decision to use a local SQLite warehouse instead of cloud Postgres',
  { embedder: realEmbedder, k: 6 },
);
console.log('\nquery: "local SQLite warehouse vs cloud Postgres" (cross-source top-6):');
for (const h of hits) {
  console.log(
    `[${h.source}] ${h.score.toFixed(4)}  ${h.content.slice(0, 84).replace(/\s+/g, ' ')}`,
  );
}
db.close();

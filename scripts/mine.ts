// Matrix Phase 2 - Mine v1 runnable pass ("second brain talks back").
//
// No Orphan Loops contract:
//   owner: Sky Lynx (run by hand today; the recurring schedule is a Phase 4 cron, not this script)
//   sink:  ~/notes/daily/<YYYY-MM-DD>.md (appended) + outcome(fed_work) rows in store/matrix.db
//   kill:  one-shot, no retry loop; a low-signal pass prints [LOW_SIGNAL] and writes NOTHING
//
// Usage:
//   source ~/.env.shared && npx tsx scripts/mine.ts [--db PATH] [--dry-run] [--no-semantic]
//   --db        warehouse path (default: the canonical store in the main matrix checkout)
//   --dry-run   compute + print findings, write nothing (preview before committing to the note)
//   --no-semantic  skip the light-semantic cross-context enrichment (git-staleness core only)
//
// Run with GOOGLE_API_KEY unset so the @google/genai env-scan does not print its misleading
// warning; the enricher here reuses STORED vectors and never calls the network anyway.

import { openDb } from '../src/db/open.js';
import { initVec, knn, EMBED_MODEL } from '../src/db/vec.js';
import { runMineV1, type SemanticEnricher } from '../src/mine/mine-v1.js';
import { writeFindings } from '../src/mine/sink.js';

const DEFAULT_DB = '/opt/matrix/store/matrix.db';

const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(name);
}
function opt(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DB_PATH = opt('--db') ?? DEFAULT_DB;
const DRY_RUN = flag('--dry-run');
const NO_SEMANTIC = flag('--no-semantic');

/**
 * Light-semantic enricher that reuses the rep turn's STORED embedding (zero network): KNN over the
 * vec index, then count neighbours that live in a DIFFERENT project. That is the "same topic,
 * surfaces elsewhere, never linked" gap, measured without re-embedding and without the empty link
 * table.
 */
function makeStoredVectorEnricher(db: ReturnType<typeof openDb>): SemanticEnricher {
  const getVec = db.prepare('SELECT vector FROM embedding WHERE turn_id = ? AND model = ? LIMIT 1');
  const getProject = db.prepare('SELECT project FROM conversation_turn WHERE turn_id = ?');
  return {
    async crossContextRecurrence(turnId: string, project: string): Promise<number> {
      const row = getVec.get(turnId, EMBED_MODEL) as { vector: Buffer } | undefined;
      if (!row) return 0;
      const buf = row.vector;
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const hits = knn(db, Array.from(f32), 40);
      let outside = 0;
      for (const h of hits) {
        if (h.turn_id === turnId) continue;
        const p = getProject.get(h.turn_id) as { project: string } | undefined;
        if (p && p.project !== project) outside += 1;
      }
      return outside;
    },
  };
}

const db = openDb(DB_PATH);

let semantic: SemanticEnricher | undefined;
if (!NO_SEMANTIC) {
  try {
    initVec(db);
    semantic = makeStoredVectorEnricher(db);
  } catch (e) {
    console.warn(`light-semantic disabled (vec init failed): ${(e as Error).message}`);
  }
}

console.log(
  `=== Matrix Mine v1 === db=${DB_PATH} dryRun=${DRY_RUN} semantic=${semantic !== undefined}`,
);

const res = await runMineV1(db, { semantic });

console.log(`scanned ${res.scannedProjects} discussed-and-resolvable project(s)`);

if (res.lowSignal) {
  console.log('[LOW_SIGNAL] no lifecycle gap cleared the thresholds. Pausing, writing nothing.');
  db.close();
  process.exit(0);
}

console.log(`\n${res.findings.length} finding(s):`);
for (const f of res.findings) {
  console.log(`  - ${f.headline}  [score=${f.score.toFixed(1)}]`);
}

if (DRY_RUN) {
  console.log('\n--dry-run: no daily note written, no outcome rows recorded.');
  db.close();
  process.exit(0);
}

const sink = writeFindings(db, res.findings, {});
console.log(`\nwrote daily note: ${sink.notePath}`);
console.log(`recorded ${sink.outcomeRows} outcome(fed_work=false) row(s).`);

db.close();
console.log('DONE.');

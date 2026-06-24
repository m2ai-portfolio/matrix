// Tests for the Mine semantic enricher (the concrete SemanticEnricher).
//
// Two layers:
//   - Injected-seam unit tests: prove the counting/filtering/bucketing logic in isolation
//     (self-exclusion, distance threshold, same-project exclusion, cross-source bucketing,
//     sort + topBuckets cap, the not-embedded -> count 0 short-circuit). Zero DB I/O.
//   - One real-DB roundtrip: store embeddings + vec rows in an in-memory warehouse and confirm
//     the DEFAULT seams (decode stored blob -> KNN -> lookup) produce the right cross-context.

import { describe, it, expect } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../src/db/open.js';
import { EMBED_MODEL, EMBED_DIM, initVec, upsertVec } from '../src/db/vec.js';
import { createSemanticEnricher } from '../src/mine/semantic-enricher.js';
import type { KnnHit } from '../src/db/vec.js';

describe('createSemanticEnricher — counting + bucketing (injected seams)', () => {
  const db = openDb(':memory:'); // never touched; all seams injected

  const lookup: Record<string, { project: string; source: string }> = {
    seed: { project: 'projA', source: 'claude_code' },
    b1: { project: 'projB', source: 'claude_code' },
    b2: { project: 'projB', source: 'claude_code' },
    cg: { project: '', source: 'chatgpt' },
    same: { project: 'projA', source: 'claude_code' }, // inside the same named project
    far: { project: 'projB', source: 'claude_code' }, // beyond maxDistance
  };

  it('excludes self/same-project/too-far/unknown and buckets the rest by where it recurs', async () => {
    const hits: KnnHit[] = [
      { turn_id: 'seed', distance: 0 }, // self
      { turn_id: 'same', distance: 0.2 }, // same named project
      { turn_id: 'b1', distance: 0.3 },
      { turn_id: 'gone', distance: 0.4 }, // lookup returns undefined
      { turn_id: 'b2', distance: 0.5 },
      { turn_id: 'cg', distance: 0.6 }, // cross-source -> bucket by source
      { turn_id: 'far', distance: 0.9 }, // > maxDistance
    ];
    const enricher = createSemanticEnricher(db, {
      maxDistance: 0.72,
      getVector: () => [1], // truthy: proceed to knn (length irrelevant; knn is injected)
      knn: () => hits,
      lookupTurn: (id) => lookup[id],
    });

    const cc = await enricher.crossContextRecurrence(['seed'], 'projA');
    expect(cc.count).toBe(3); // b1, b2, cg
    expect(cc.buckets).toEqual([
      { key: 'projB', count: 2 }, // sorted desc
      { key: 'chatgpt', count: 1 },
    ]);
  });

  it('returns count 0 without calling knn when the turn is not embedded', async () => {
    let knnCalls = 0;
    const enricher = createSemanticEnricher(db, {
      getVector: () => undefined, // not embedded
      knn: () => {
        knnCalls++;
        return [];
      },
      lookupTurn: () => undefined,
    });
    const cc = await enricher.crossContextRecurrence(['seed'], 'projA');
    expect(cc).toEqual({ count: 0, buckets: [] });
    expect(knnCalls).toBe(0);
  });

  it('skips unembedded candidates, probes the next embedded ones, and dedups shared neighbors', async () => {
    // t1 unembedded (today's turn), t2 + t3 embedded. A shared neighbor 'shared' is near BOTH
    // t2 and t3 but must be counted ONCE; 'only3' is near t3 only.
    const vectors: Record<string, number[] | undefined> = {
      t1: undefined, // not embedded
      t2: [1],
      t3: [1],
    };
    const knnByProbe: Record<string, KnnHit[]> = {
      t2: [
        { turn_id: 'shared', distance: 0.2 },
        { turn_id: 't3', distance: 0.1 }, // another probe turn -> excluded
      ],
      t3: [
        { turn_id: 'shared', distance: 0.3 }, // already counted via t2
        { turn_id: 'only3', distance: 0.4 },
      ],
    };
    let probeCalls = 0;
    let currentProbe = '';
    const enricher = createSemanticEnricher(db, {
      maxProbes: 5,
      getVector: (id) => vectors[id],
      knn: (vec) => {
        probeCalls++;
        // identify which probe by call order: t2 then t3 (t1 skipped before knn)
        currentProbe = probeCalls === 1 ? 't2' : 't3';
        return knnByProbe[currentProbe];
      },
      lookupTurn: (id) => ({ project: 'projX', source: 'claude_code' }),
    });
    const cc = await enricher.crossContextRecurrence(['t1', 't2', 't3'], 'projA');
    expect(probeCalls).toBe(2); // t1 skipped (unembedded), t2 + t3 probed
    expect(cc.count).toBe(2); // 'shared' (deduped) + 'only3'
    expect(cc.buckets).toEqual([{ key: 'projX', count: 2 }]);
  });

  it('drops non-actionable contexts (ephemeral temp dirs, uncategorized home) from count + buckets', async () => {
    const hits: KnnHit[] = [
      { turn_id: 'real', distance: 0.2 }, // a named repo -> kept
      { turn_id: 'home', distance: 0.2 }, // bare home -> dropped
      { turn_id: 'tmp', distance: 0.2 }, // CMD worktree temp -> dropped
      { turn_id: 'cross', distance: 0.2 }, // cross-source lane -> kept
    ];
    const ctx: Record<string, { project: string; source: string }> = {
      real: { project: '-home-user-projects-ideaforge', source: 'claude_code' },
      home: { project: '-home-user', source: 'claude_code' },
      tmp: { project: '-tmp-cmd-wt-abc', source: 'claude_code' },
      cross: { project: '', source: 'chatgpt' },
    };
    const enricher = createSemanticEnricher(db, {
      getVector: () => [1],
      knn: () => hits,
      lookupTurn: (id) => ctx[id],
    });
    const cc = await enricher.crossContextRecurrence(['seed'], 'projA');
    expect(cc.count).toBe(2); // real + cross only
    expect(cc.buckets.map((b) => b.key).sort()).toEqual([
      '-home-user-projects-ideaforge',
      'chatgpt',
    ]);
  });

  it('caps the breakdown to topBuckets while still counting every match', async () => {
    const hits: KnnHit[] = [
      { turn_id: 'x1', distance: 0.1 },
      { turn_id: 'x2', distance: 0.1 },
      { turn_id: 'x3', distance: 0.1 },
      { turn_id: 'x4', distance: 0.1 },
    ];
    const enricher = createSemanticEnricher(db, {
      topBuckets: 2,
      getVector: () => [1],
      knn: () => hits,
      lookupTurn: (id) => ({ project: '', source: `src-${id}` }), // 4 distinct sources
    });
    const cc = await enricher.crossContextRecurrence(['seed'], 'projA');
    expect(cc.count).toBe(4); // every match counted
    expect(cc.buckets).toHaveLength(2); // breakdown capped
  });
});

describe('createSemanticEnricher — real DB roundtrip (default seams)', () => {
  /** A unit basis vector e_i in EMBED_DIM space (normalized; L2 distance between distinct e_i is √2). */
  function basis(i: number): number[] {
    const v = new Array<number>(EMBED_DIM).fill(0);
    v[i] = 1;
    return v;
  }

  function seedTurn(
    db: Database,
    turnId: string,
    project: string,
    source: string,
    vec: number[],
  ): void {
    db.prepare(
      `INSERT INTO conversation_turn (turn_id, source, source_id, ingestion_batch_id,
         conversation_id, ts, role, content, tokens, project, meta)
       VALUES (?, ?, ?, 'b', 'c', '2026-06-23T00:00:00.000Z', 'user', 'x', 1, ?, '{}')`,
    ).run(turnId, source, turnId, project);
    db.prepare('INSERT INTO embedding (turn_id, model, dim, vector) VALUES (?, ?, ?, ?)').run(
      turnId,
      EMBED_MODEL,
      EMBED_DIM,
      Buffer.from(new Float32Array(vec).buffer),
    );
    upsertVec(db, turnId, vec);
  }

  it('finds cross-context neighbors via stored vectors and excludes same-project/far turns', async () => {
    const db = openDb(':memory:');
    initVec(db);
    const A = basis(0);
    const B = basis(1); // orthogonal to A: L2 distance √2 ≈ 1.414 > 0.72

    seedTurn(db, 'seed', 'projA', 'claude_code', A);
    seedTurn(db, 'near', 'projB', 'claude_code', A); // identical vector, distance 0 -> counted
    seedTurn(db, 'crosssrc', '', 'chatgpt', A); // cross-source, distance 0 -> counted (bucket chatgpt)
    seedTurn(db, 'same', 'projA', 'claude_code', A); // same project -> excluded
    seedTurn(db, 'far', 'projC', 'claude_code', B); // orthogonal -> beyond threshold -> excluded

    const enricher = createSemanticEnricher(db); // DEFAULT seams: read blob, KNN, lookup
    const cc = await enricher.crossContextRecurrence(['seed'], 'projA');

    expect(cc.count).toBe(2);
    expect(cc.buckets).toEqual([
      { key: 'chatgpt', count: 1 }, // ties broken by key.localeCompare: 'chatgpt' < 'projB'
      { key: 'projB', count: 1 },
    ]);
    db.close();
  });
});

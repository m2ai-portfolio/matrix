// Matrix Phase 2 - Mine v1 test contract.
//
// Contract (from card Q-20260614-0002 "Done when"):
//   M-1 a gap fixture -> a real finding lands in the daily note AND an outcome row exists.
//   M-2 an all-fresh fixture -> [LOW_SIGNAL]/pause: zero findings, zero writes.
//   M-3 mixed-format ts (epoch seconds AND ISO strings) both normalize and count.
//   M-4 hermetic: git + project-dir resolution are injected; no real git/FS/claudeclaw access.
//   M-5 a recently-committed project is NOT flagged stale even when discussed.
//   M-6 below-threshold discussion (< minTurns) does not produce a finding.
//   M-7 light-semantic enrichment annotates findings via the injected seam.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDb } from '../src/db/open.js';
import {
  runMineV1,
  normalizeTs,
  encodePath,
  defaultProjectDirMap,
  type SemanticEnricher,
} from '../src/mine/mine-v1.js';
import { writeFindings } from '../src/mine/sink.js';
import { makeTmpDir, cleanupTmpDir } from './helpers/tmp.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-14T12:00:00.000Z');

let db: Database;
let tmp: string;

beforeEach(() => {
  db = openDb(':memory:');
  tmp = makeTmpDir('matrix-mine-');
});

afterEach(() => {
  db.close();
  cleanupTmpDir(tmp);
});

interface SeedTurn {
  turn_id: string;
  project: string;
  ts: string | number;
  conversation_id: string;
}

function seed(turns: SeedTurn[]): void {
  const insert = db.prepare(
    `INSERT INTO conversation_turn
      (turn_id, source, source_id, ingestion_batch_id, conversation_id, ts, role, content, tokens, project, meta)
     VALUES (@turn_id, 'claude_code', @turn_id, 'b', @conversation_id, @ts, 'user', 'x', 1, @project, '{}')`,
  );
  const tx = db.transaction((rows: SeedTurn[]) => {
    for (const r of rows) insert.run(r);
  });
  tx(turns);
}

/** epoch-SECONDS form (a number) for `daysAgo` before NOW. */
function tsSeconds(daysAgo: number): number {
  return Math.floor((NOW - daysAgo * DAY) / 1000);
}

/** ISO-STRING form for `daysAgo` before NOW. */
function tsIso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

const STALE_DIR = '/fake/projects/p-stale';
const FRESH_DIR = '/fake/projects/p-fresh';
const STALE_ENC = encodePath(STALE_DIR);
const FRESH_ENC = encodePath(FRESH_DIR);

/** Map both fake projects; git times injected per-test. */
function dirMap(): Map<string, string> {
  return new Map([
    [STALE_ENC, STALE_DIR],
    [FRESH_ENC, FRESH_DIR],
  ]);
}

describe('M-3: mixed-format ts normalization', () => {
  it('normalizes epoch seconds, ms, ISO strings, numeric strings; rejects junk', () => {
    expect(normalizeTs(1_773_458_170)).toBe(1_773_458_170_000); // seconds -> ms
    expect(normalizeTs(1_776_000_000_000)).toBe(1_776_000_000_000); // already ms
    expect(normalizeTs('1773458170')).toBe(1_773_458_170_000); // numeric string seconds
    expect(normalizeTs('2026-06-14T04:06:05.168Z')).toBe(Date.parse('2026-06-14T04:06:05.168Z'));
    expect(normalizeTs(null)).toBeUndefined();
    expect(normalizeTs('')).toBeUndefined();
    expect(normalizeTs('not-a-date')).toBeUndefined();
  });

  it('counts both epoch-seconds and ISO-string turns in the recency window', async () => {
    seed([
      { turn_id: 't1', project: STALE_ENC, ts: tsSeconds(2), conversation_id: 'c1' },
      { turn_id: 't2', project: STALE_ENC, ts: tsIso(3), conversation_id: 'c2' },
      { turn_id: 't3', project: STALE_ENC, ts: tsSeconds(5), conversation_id: 'c1' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: () => NOW - 60 * DAY,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].recentTurns).toBe(3); // all three normalized + in-window
    expect(res.findings[0].distinctConversations).toBe(2); // c1, c2
  });
});

describe('M-1: gap fixture lands a finding + daily note + outcome row', () => {
  it('emits a finding, writes the daily note, and records one outcome row', async () => {
    seed([
      { turn_id: 'a1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'a2', project: STALE_ENC, ts: tsIso(2), conversation_id: 'c2' },
      { turn_id: 'a3', project: STALE_ENC, ts: tsSeconds(4), conversation_id: 'c2' },
      { turn_id: 'a4', project: STALE_ENC, ts: tsSeconds(6), conversation_id: 'c1' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: (dir) => (dir === STALE_DIR ? NOW - 60 * DAY : undefined),
    });
    expect(res.lowSignal).toBe(false);
    expect(res.findings).toHaveLength(1);
    const f = res.findings[0];
    expect(f.project).toBe(STALE_ENC);
    expect(f.recentTurns).toBe(4);
    expect(Math.round(f.gitStaleDays)).toBe(60);
    expect(f.representativeTurnId).toBe('a1'); // most-recent in-window turn

    const dailyDir = join(tmp, 'daily');
    const sink = writeFindings(db, res.findings, { vaultDailyDir: dailyDir, now: NOW });
    expect(sink.outcomeRows).toBe(1);
    expect(existsSync(sink.notePath)).toBe(true);
    const note = readFileSync(sink.notePath, 'utf8');
    expect(note).toContain('Matrix Mine');
    expect(note).toContain('p-stale');
    expect(note).toContain('Lifecycle gap');

    const row = db.prepare('SELECT turn_id, fed_work, artifact_ref FROM outcome').get() as {
      turn_id: string;
      fed_work: number;
      artifact_ref: string;
    };
    expect(row.turn_id).toBe('a1');
    expect(row.fed_work).toBe(0);
    expect(row.artifact_ref).toBe(sink.notePath);
  });

  it('appends a second Mine section to an existing daily note without clobbering', async () => {
    seed([
      { turn_id: 'a1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'a2', project: STALE_ENC, ts: tsSeconds(2), conversation_id: 'c2' },
      { turn_id: 'a3', project: STALE_ENC, ts: tsSeconds(3), conversation_id: 'c1' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: () => NOW - 60 * DAY,
    });
    const dailyDir = join(tmp, 'daily');
    const first = writeFindings(db, res.findings, { vaultDailyDir: dailyDir, now: NOW });
    const second = writeFindings(db, res.findings, { vaultDailyDir: dailyDir, now: NOW });
    expect(second.notePath).toBe(first.notePath); // same day, same file
    const note = readFileSync(first.notePath, 'utf8');
    expect(note.match(/## Matrix Mine/g)).toHaveLength(2); // both sections present
    expect(db.prepare('SELECT COUNT(*) n FROM outcome').get()).toEqual({ n: 2 });
  });
});

describe('M-2: all-fresh fixture pauses on low signal (anti-slop)', () => {
  it('returns lowSignal with no findings and writes nothing', async () => {
    seed([
      { turn_id: 'f1', project: FRESH_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'f2', project: FRESH_ENC, ts: tsSeconds(2), conversation_id: 'c2' },
      { turn_id: 'f3', project: FRESH_ENC, ts: tsSeconds(3), conversation_id: 'c3' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: () => NOW - 2 * DAY, // committed 2 days ago: actively shipped
    });
    expect(res.lowSignal).toBe(true);
    expect(res.findings).toHaveLength(0);

    const dailyDir = join(tmp, 'daily');
    const sink = writeFindings(db, res.findings, { vaultDailyDir: dailyDir, now: NOW });
    expect(sink.notePath).toBe('');
    expect(sink.outcomeRows).toBe(0);
    expect(existsSync(dailyDir)).toBe(false); // nothing created
    expect(db.prepare('SELECT COUNT(*) n FROM outcome').get()).toEqual({ n: 0 });
  });
});

describe('M-5: recently-committed project is not flagged stale', () => {
  it('excludes a heavily-discussed project whose repo was committed inside the threshold', async () => {
    seed([
      { turn_id: 'r1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'r2', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c2' },
      { turn_id: 'r3', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c3' },
      { turn_id: 'r4', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c4' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      staleThresholdDays: 30,
      gitLastCommitMs: () => NOW - 5 * DAY, // 5 days < 30 day threshold
    });
    expect(res.lowSignal).toBe(true);
    expect(res.findings).toHaveLength(0);
  });
});

describe('M-6: below-threshold discussion produces no finding', () => {
  it('ignores a stale project discussed fewer than minTurnsInWindow times', async () => {
    seed([
      { turn_id: 'b1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'b2', project: STALE_ENC, ts: tsSeconds(2), conversation_id: 'c1' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      minTurnsInWindow: 3,
      gitLastCommitMs: () => NOW - 90 * DAY,
    });
    expect(res.lowSignal).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('ignores turns outside the recency window', async () => {
    seed([
      { turn_id: 'o1', project: STALE_ENC, ts: tsSeconds(40), conversation_id: 'c1' },
      { turn_id: 'o2', project: STALE_ENC, ts: tsSeconds(50), conversation_id: 'c2' },
      { turn_id: 'o3', project: STALE_ENC, ts: tsSeconds(60), conversation_id: 'c3' },
    ]);
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      recentWindowDays: 14,
      gitLastCommitMs: () => NOW - 90 * DAY,
    });
    expect(res.lowSignal).toBe(true); // all discussion is > 14 days old
  });
});

describe('M-4: hermetic resolution (git + project dirs injected)', () => {
  it('only calls the injected git function, with the mapped directory', async () => {
    seed([
      { turn_id: 'h1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 'h2', project: STALE_ENC, ts: tsSeconds(2), conversation_id: 'c2' },
      { turn_id: 'h3', project: STALE_ENC, ts: tsSeconds(3), conversation_id: 'c3' },
    ]);
    const seenDirs: string[] = [];
    await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: (dir) => {
        seenDirs.push(dir);
        return NOW - 60 * DAY;
      },
    });
    expect(seenDirs).toContain(STALE_DIR);
    expect(seenDirs.every((d) => d.startsWith('/fake/'))).toBe(true); // never a real path
  });

  it('defaultProjectDirMap forward-encodes only real git repos under the root', () => {
    const repo = join(tmp, 'myrepo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(tmp, 'not-a-repo'), { recursive: true });
    const map = defaultProjectDirMap(tmp);
    expect(map.get(encodePath(repo))).toBe(repo);
    expect(map.has(encodePath(join(tmp, 'not-a-repo')))).toBe(false);
  });
});

describe('M-7: light-semantic enrichment', () => {
  it('annotates findings with cross-context recurrence from the injected seam', async () => {
    seed([
      { turn_id: 's1', project: STALE_ENC, ts: tsSeconds(1), conversation_id: 'c1' },
      { turn_id: 's2', project: STALE_ENC, ts: tsSeconds(2), conversation_id: 'c2' },
      { turn_id: 's3', project: STALE_ENC, ts: tsSeconds(3), conversation_id: 'c3' },
    ]);
    const enricher: SemanticEnricher = {
      crossContextRecurrence: async () => ({
        count: 7,
        buckets: [
          { key: 'chatgpt', count: 4 },
          { key: '-home-user-projects-ideaforge', count: 3 },
        ],
      }),
    };
    const res = await runMineV1(db, {
      now: NOW,
      projectDirMap: dirMap(),
      gitLastCommitMs: () => NOW - 60 * DAY,
      semantic: enricher,
    });
    expect(res.findings[0].crossContext?.count).toBe(7);
    expect(res.findings[0].headline).toContain('never linked');
    // The breakdown names WHERE it recurs, with the project key rendered as its repo tail.
    expect(res.findings[0].headline).toContain('chatgpt ×4');
    expect(res.findings[0].headline).toContain('ideaforge ×3');
  });
});

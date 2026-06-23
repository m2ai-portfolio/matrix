// Tests for the Mine v1 run entrypoint (analytics-loop activation).
//
// Hermetic: a temp warehouse seeded with conversation_turn rows + injected
// git-staleness drives a deterministic finding. The notes sink writes into a temp
// dir, never ~/notes. Asserts the three orchestration paths: write, low-signal
// (anti-slop), and dry-run.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db/open.js';
import { mineOnce, parseMineArgs } from './run.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed ms clock
const PROJECT = '-home-user-projects-foo'; // Claude-Code-style encoded path
const PROJECT_DIR = '/home/user/projects/foo';

function seedWarehouse() {
  const dbPath = join(tmpdir(), `matrix-mine-${process.pid}-${Math.floor(performance.now())}.db`);
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO conversation_turn (turn_id, project, conversation_id, ts) VALUES (?, ?, ?, ?)',
  );
  // 3 recent turns across 2 conversations (clears minTurns=3, distinct=2).
  ins.run('t1', PROJECT, 'c1', NOW - 1 * DAY);
  ins.run('t2', PROJECT, 'c1', NOW - 2 * DAY);
  ins.run('t3', PROJECT, 'c2', NOW - 1 * DAY);
  return db;
}

const dirMap = new Map<string, string>([[PROJECT, PROJECT_DIR]]);

describe('parseMineArgs', () => {
  it('detects --dry-run / -n, defaults to false', () => {
    expect(parseMineArgs([]).dryRun).toBe(false);
    expect(parseMineArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseMineArgs(['-n']).dryRun).toBe(true);
  });
});

describe('mineOnce', () => {
  it('writes findings + outcome rows when a stale-but-discussed project is found', async () => {
    const db = seedWarehouse();
    const vaultDir = mkdtempSync(join(tmpdir(), 'matrix-notes-'));
    try {
      const out = await mineOnce({
        db,
        mine: { now: NOW, projectDirMap: dirMap, gitLastCommitMs: () => NOW - 40 * DAY },
        sink: { vaultDailyDir: vaultDir, now: NOW },
        log: () => {},
      });

      expect(out.wrote).toBe(true);
      expect(out.result.lowSignal).toBe(false);
      expect(out.result.findings).toHaveLength(1);
      expect(out.sink?.outcomeRows).toBe(1);
      expect(out.sink?.notePath && existsSync(out.sink.notePath)).toBe(true);
      expect(readFileSync(out.sink!.notePath, 'utf8')).toContain('## Matrix Mine');

      const outcomes = db.prepare('SELECT COUNT(*) c FROM outcome').get() as { c: number };
      expect(outcomes.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('writes nothing when the project was recently committed (low-signal / anti-slop)', async () => {
    const db = seedWarehouse();
    const vaultDir = mkdtempSync(join(tmpdir(), 'matrix-notes-'));
    try {
      const out = await mineOnce({
        db,
        // committed 5 days ago => not stale => no finding.
        mine: { now: NOW, projectDirMap: dirMap, gitLastCommitMs: () => NOW - 5 * DAY },
        sink: { vaultDailyDir: vaultDir, now: NOW },
        log: () => {},
      });

      expect(out.result.lowSignal).toBe(true);
      expect(out.wrote).toBe(false);
      expect(out.sink).toBeUndefined();
      const outcomes = db.prepare('SELECT COUNT(*) c FROM outcome').get() as { c: number };
      expect(outcomes.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('dry-run reports findings but writes neither note nor outcome rows', async () => {
    const db = seedWarehouse();
    const vaultDir = mkdtempSync(join(tmpdir(), 'matrix-notes-'));
    try {
      const out = await mineOnce({
        db,
        dryRun: true,
        mine: { now: NOW, projectDirMap: dirMap, gitLastCommitMs: () => NOW - 40 * DAY },
        sink: { vaultDailyDir: vaultDir, now: NOW },
        log: () => {},
      });

      expect(out.result.findings).toHaveLength(1); // found...
      expect(out.wrote).toBe(false); // ...but wrote nothing
      expect(out.sink).toBeUndefined();
      const outcomes = db.prepare('SELECT COUNT(*) c FROM outcome').get() as { c: number };
      expect(outcomes.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

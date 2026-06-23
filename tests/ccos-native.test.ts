// Matrix Fleet Visibility - ccos-native adapter tests (fixture-only).
//
// SAFETY: no test ever opens a real path under ~/projects/claudeclaw-os or
// ~/.claudeclaw. Every fixture DB, PID file, and credentials file lives under a
// fresh os.tmpdir() directory created with mkdtemp and removed afterward. The
// fixture DB is built WRITABLE here (seeding) and then the ADAPTER opens it
// read-only, exactly as it would the live DB.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createCcosNativeAdapter } from '../src/fleet/adapters/ccos-native.js';
import { openOpsDb } from '../src/ops/open.js';
import { getActivity, getFleet } from '../src/ops/queries.js';
import { runSync } from '../src/fleet/sync.js';

// A fixed "now" so day-boundary and idle math are deterministic.
// 2026-06-14T18:00:00 local (ms). We derive local-day boundaries from this.
const NOW = new Date(2026, 5, 14, 18, 0, 0, 0).getTime();
const startOfToday = (() => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
// Seconds and ms helpers for the local timezone.
const todaySec = Math.floor((startOfToday + 9 * 3600_000) / 1000); // ~09:00 today, seconds
const todayMs = startOfToday + 10 * 3600_000; // 10:00 today, ms
const yesterdaySec = Math.floor((startOfToday - 3600_000) / 1000); // 23:00 yesterday, seconds
const recentMs = NOW - 5 * 60 * 1000; // 5 min ago: inside the 15 min idle window

let dir: string;

function fixtureDbPath(): string {
  return join(dir, 'claudeclaw.db');
}

interface SeedOptions {
  withHiveMind?: boolean;
  withTokenUsage?: boolean;
  tokenHasCost?: boolean;
}

/** Build a writable fixture DB with the live-shaped (migrated) schema. */
function seedDb(opts: SeedOptions = {}): void {
  const { withHiveMind = true, withTokenUsage = true, tokenHasCost = true } = opts;
  const db = new Database(fixtureDbPath());

  if (withHiveMind) {
    db.exec(`CREATE TABLE hive_mind (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT,
      action TEXT,
      summary TEXT,
      artifacts TEXT,
      created_at INTEGER NOT NULL,
      topic_id TEXT
    )`);
  }

  if (withTokenUsage) {
    // Mirror the live (migrated) shape: agent_id is present, plus optional cost_usd.
    const costCol = tokenHasCost ? 'cost_usd REAL,' : '';
    db.exec(`CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      session_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      ${costCol}
      created_at INTEGER NOT NULL,
      agent_id TEXT
    )`);
  }

  db.close();
}

function insertHive(
  rows: Array<{
    agentId: string;
    action?: string;
    summary?: string;
    createdAt: number;
  }>,
): void {
  const db = new Database(fixtureDbPath());
  const stmt = db.prepare(
    "INSERT INTO hive_mind (agent_id, chat_id, action, summary, created_at) VALUES (?, 'c', ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.agentId, r.action ?? null, r.summary ?? null, r.createdAt);
  db.close();
}

function insertTokens(
  rows: Array<{
    agentId: string;
    cost?: number;
    createdAt: number;
  }>,
  withCost = true,
): void {
  const db = new Database(fixtureDbPath());
  const stmt = withCost
    ? db.prepare('INSERT INTO token_usage (agent_id, cost_usd, created_at) VALUES (?, ?, ?)')
    : db.prepare('INSERT INTO token_usage (agent_id, created_at) VALUES (?, ?)');
  for (const r of rows) {
    if (withCost) stmt.run(r.agentId, r.cost ?? 0, r.createdAt);
    else stmt.run(r.agentId, r.createdAt);
  }
  db.close();
}

function writePid(id: string, value: string): void {
  const name = id === 'main' ? 'claudeclaw.pid' : `agent-${id}.pid`;
  writeFileSync(join(dir, name), value);
}

function writeCreds(content: string): string {
  const p = join(dir, '.credentials.json');
  writeFileSync(p, content);
  return p;
}

/** A baseline config that pins every path into the temp dir. */
function cfg(overrides: Partial<Parameters<typeof createCcosNativeAdapter>[0]> = {}) {
  return createCcosNativeAdapter({
    dbPath: fixtureDbPath(),
    storeDir: dir,
    credentialsPath: join(dir, '.credentials.json'),
    agentIds: ['main', 'sheridan', 'galvatron', 'starscream'],
    now: () => NOW,
    isProcessAlive: () => false, // default to dead unless a test overrides
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccos-native-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('factory + contract (C-01,C-02,C-03)', () => {
  it('returns a FleetAdapter with source ccos and a pull() (C-01,C-02)', () => {
    seedDb();
    const a = cfg();
    expect(a.source).toBe('ccos');
    expect(typeof a.pull).toBe('function');
  });

  it('pull() resolves to a FleetPull shape (C-03)', async () => {
    seedDb();
    const out = await cfg().pull();
    expect(Array.isArray(out.agents)).toBe(true);
    expect(Array.isArray(out.statuses)).toBe(true);
    expect(Array.isArray(out.events)).toBe(true);
  });
});

describe('agent records (C-04,C-05,C-25,C-30)', () => {
  it('one record per default agent id with name map + owner (C-04,C-05)', async () => {
    seedDb();
    const { agents } = await cfg().pull();
    expect(agents.map((a) => a.agentId)).toEqual(['main', 'sheridan', 'galvatron', 'starscream']);
    const byId = Object.fromEntries(agents.map((a) => [a.agentId, a]));
    expect(byId.main.name).toBe('Data');
    expect(byId.sheridan.name).toBe('Sheridan');
    expect(byId.galvatron.name).toBe('Galvatron');
    expect(byId.starscream.name).toBe('Starscream');
    expect(agents.every((a) => a.ownerHuman === 'the owner')).toBe(true);
    expect(agents.every((a) => a.source === 'ccos')).toBe(true);
  });

  it('model is left undefined in v1 (C-25)', async () => {
    seedDb();
    const { agents } = await cfg().pull();
    expect(agents.every((a) => a.model === undefined)).toBe(true);
  });

  it('every emitted agentId is a configured id (C-30)', async () => {
    seedDb();
    insertHive([{ agentId: 'main', action: 'x', summary: 'y', createdAt: todayMs }]);
    const ids = new Set(['main', 'sheridan', 'galvatron', 'starscream']);
    const { statuses, events } = await cfg().pull();
    expect(statuses.every((s) => ids.has(s.agentId))).toBe(true);
    expect(events.every((e) => ids.has(e.agentId))).toBe(true);
  });
});

describe('status classification (C-06..C-11,C-37,C-38)', () => {
  it('alive PID with recent activity => up; correct file names per agent (C-06,C-07)', async () => {
    seedDb();
    insertHive([{ agentId: 'main', summary: 'recent', createdAt: recentMs }]);
    insertHive([{ agentId: 'galvatron', summary: 'recent', createdAt: recentMs }]);
    writePid('main', '1234'); // -> claudeclaw.pid
    writePid('galvatron', '5678'); // -> agent-galvatron.pid
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const byId = Object.fromEntries(out.statuses.map((s) => [s.agentId, s]));
    expect(byId.main.status).toBe('up');
    expect(byId.galvatron.status).toBe('up');
    // confirm the file names the adapter read are the spec names
    expect(readFileSync(join(dir, 'claudeclaw.pid'), 'utf-8')).toBe('1234');
    expect(readFileSync(join(dir, 'agent-galvatron.pid'), 'utf-8')).toBe('5678');
  });

  it('alive PID but stale activity => idle (C-08)', async () => {
    seedDb();
    // activity 30 min ago -> older than the 15 min idle window
    insertHive([{ agentId: 'main', summary: 'old', createdAt: NOW - 30 * 60 * 1000 }]);
    writePid('main', '1234');
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).toBe('idle');
  });

  it('missing PID file => unknown (C-09)', async () => {
    seedDb();
    // write PID for only main; others have none
    writePid('main', '1234');
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const sheridan = out.statuses.find((s) => s.agentId === 'sheridan')!;
    expect(sheridan.status).toBe('unknown');
    expect(sheridan.detail).toContain('no PID file');
  });

  it('dead PID + expired creds => oauth-expired with detail (C-10)', async () => {
    seedDb();
    writePid('main', '1234');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW - 1000 } }));
    const out = await cfg({ isProcessAlive: () => false }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).toBe('oauth-expired');
    expect((main.detail ?? '').toLowerCase()).toContain('token');
  });

  it('dead PID + valid creds => down (C-11)', async () => {
    seedDb();
    writePid('main', '1234');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 3600_000 } }));
    const out = await cfg({ isProcessAlive: () => false }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).toBe('down');
  });

  it('PID file with surrounding whitespace parses (C-37)', async () => {
    seedDb();
    writePid('main', '  4321\n');
    let probed: number | undefined;
    const out = await cfg({
      isProcessAlive: (pid) => {
        probed = pid;
        return true;
      },
    }).pull();
    expect(probed).toBe(4321);
    expect(out.statuses.find((s) => s.agentId === 'main')!.status).toBe('up');
  });

  it('PID file with garbage => not-alive, no throw (C-23,C-38)', async () => {
    seedDb();
    writePid('main', 'notanint');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 1000 } }));
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(['down', 'oauth-expired']).toContain(main.status);
  });
});

describe('credentials robustness (C-22,C-34,C-35,C-36)', () => {
  it('malformed creds JSON => down, no throw (C-22,C-34)', async () => {
    seedDb();
    writePid('main', '1234');
    writeCreds('{ broken json');
    const out = await cfg({ isProcessAlive: () => false }).pull();
    expect(out.statuses.find((s) => s.agentId === 'main')!.status).toBe('down');
  });

  it('missing creds file => down, no throw (C-35)', async () => {
    seedDb();
    writePid('main', '1234');
    // do not write any credentials file; point at a nonexistent path
    const out = await cfg({
      isProcessAlive: () => false,
      credentialsPath: join(dir, 'does-not-exist.json'),
    }).pull();
    expect(out.statuses.find((s) => s.agentId === 'main')!.status).toBe('down');
  });

  it('creds without claudeAiOauth.expiresAt => down (C-36)', async () => {
    seedDb();
    writePid('main', '1234');
    writeCreds(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    const out = await cfg({ isProcessAlive: () => false }).pull();
    expect(out.statuses.find((s) => s.agentId === 'main')!.status).toBe('down');
  });
});

describe('token rollup + lastSeen (C-12,C-13,C-33)', () => {
  it('today turns/cost summed over local day (C-12)', async () => {
    seedDb();
    insertTokens([
      { agentId: 'main', cost: 0.1, createdAt: todaySec },
      { agentId: 'main', cost: 0.25, createdAt: todayMs },
    ]);
    const out = await cfg().pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.todayTurns).toBe(2);
    expect(main.todayCost).toBeCloseTo(0.35, 6);
  });

  it('local-day boundary: yesterday excluded, today included (C-33)', async () => {
    seedDb();
    insertTokens([
      { agentId: 'main', cost: 1, createdAt: yesterdaySec }, // 23:00 yesterday
      { agentId: 'main', cost: 2, createdAt: todaySec }, // 09:00 today
    ]);
    const out = await cfg().pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.todayTurns).toBe(1);
    expect(main.todayCost).toBeCloseTo(2, 6);
  });

  it('lastSeen = max created_at across both tables, in ms (C-13)', async () => {
    seedDb();
    insertTokens([{ agentId: 'main', cost: 0, createdAt: todaySec }]); // seconds
    insertHive([{ agentId: 'main', summary: 'later', createdAt: todayMs }]); // ms, larger
    const out = await cfg().pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.lastSeen).toBe(todayMs);
  });
});

describe('activity events + time normalization (C-14,C-15,C-31,C-32)', () => {
  it('caps at the event limit, newest first (C-14)', async () => {
    seedDb();
    const rows = [];
    for (let i = 0; i < 25; i++)
      rows.push({ agentId: 'main', summary: `e${i}`, createdAt: todayMs + i });
    insertHive(rows);
    const out = await cfg({ eventLimit: 20 }).pull();
    const mainEvents = out.events.filter((e) => e.agentId === 'main');
    expect(mainEvents).toHaveLength(20);
    // newest first
    expect(mainEvents[0].summary).toBe('e24');
  });

  it('seconds rows normalize to ms; ms rows unchanged (C-15,C-31)', async () => {
    seedDb();
    insertHive([
      { agentId: 'main', summary: 'sec', createdAt: todaySec }, // seconds
      { agentId: 'main', summary: 'ms', createdAt: todayMs }, // ms
    ]);
    const out = await cfg().pull();
    const ev = Object.fromEntries(
      out.events.filter((e) => e.agentId === 'main').map((e) => [e.summary, e.createdAt]),
    );
    expect(ev.sec).toBe(todaySec * 1000);
    expect(ev.ms).toBe(todayMs);
  });

  it('boundary: 1e12 stays ms; below-threshold becomes seconds (C-32)', async () => {
    seedDb();
    insertHive([
      { agentId: 'main', summary: 'exact', createdAt: 1e12 },
      { agentId: 'main', summary: 'below', createdAt: 999_999_999_999 },
    ]);
    const out = await cfg().pull();
    const ev = Object.fromEntries(
      out.events.filter((e) => e.agentId === 'main').map((e) => [e.summary, e.createdAt]),
    );
    expect(ev.exact).toBe(1e12);
    expect(ev.below).toBe(999_999_999_999 * 1000);
  });
});

describe('read-only + path safety (C-16,C-18,C-21,C-45)', () => {
  it('a read-only handle on the fixture rejects writes (C-45 mode proof)', () => {
    // Open-MODE assertions (constructor options, only-configured-path, close-count)
    // live in tests/ccos-native.open.test.ts, which mocks the real constructor.
    // Here we confirm the consequence: a readonly+fileMustExist handle (the exact
    // mode the adapter uses) rejects a write, so the live DB cannot be mutated.
    seedDb();
    const ro = new Database(fixtureDbPath(), {
      readonly: true,
      fileMustExist: true,
    });
    expect(() => ro.exec('CREATE TABLE should_not (x INTEGER)')).toThrow(/readonly/i);
    ro.close();
  });

  it('a full pull via the default opener keeps the DB byte-identical (C-16)', async () => {
    seedDb();
    insertHive([{ agentId: 'main', summary: 'a', createdAt: todayMs }]);
    insertTokens([{ agentId: 'main', cost: 0.5, createdAt: todaySec }]);
    const before = readFileSync(fixtureDbPath());
    const adapter = createCcosNativeAdapter({
      dbPath: fixtureDbPath(),
      storeDir: dir,
      credentialsPath: join(dir, '.credentials.json'),
      agentIds: ['main'],
      now: () => NOW,
      isProcessAlive: () => false,
    });
    await adapter.pull();
    await adapter.pull(); // second pull proves no lock leak / handle reuse
    const after = readFileSync(fixtureDbPath());
    expect(after.equals(before)).toBe(true);
  });

  it('all fixture paths live under os.tmpdir(), never the real CCOS store (C-18)', () => {
    seedDb();
    const tmp = tmpdir();
    expect(fixtureDbPath().startsWith(tmp)).toBe(true);
    expect(dir.startsWith(tmp)).toBe(true);
    expect(fixtureDbPath()).not.toContain(join(homedir(), 'projects', 'claudeclaw-os'));
    expect(fixtureDbPath()).not.toContain('matrix.db');
  });

  it('pull() rejects when dbPath cannot be opened read-only (C-21)', async () => {
    // do NOT seed: file does not exist => fileMustExist makes the default open throw
    await expect(cfg().pull()).rejects.toThrow();
  });
});

describe('schema drift robustness (C-20,C-39,C-40,C-41)', () => {
  it('missing hive_mind => events [], no throw; lastSeen still from token_usage (C-20,C-39)', async () => {
    seedDb({ withHiveMind: false, withTokenUsage: true });
    insertTokens([{ agentId: 'main', cost: 0.1, createdAt: todaySec }]);
    const out = await cfg().pull();
    expect(out.events).toHaveLength(0);
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.lastSeen).toBe(todaySec * 1000);
  });

  it('missing token_usage => rollup undefined, no throw; lastSeen from hive_mind (C-40)', async () => {
    seedDb({ withHiveMind: true, withTokenUsage: false });
    insertHive([{ agentId: 'main', summary: 'h', createdAt: todayMs }]);
    const out = await cfg().pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.todayTurns).toBeUndefined();
    expect(main.todayCost).toBeUndefined();
    expect(main.lastSeen).toBe(todayMs);
  });

  it('token_usage without cost_usd => cost undefined, turns still counted (C-41)', async () => {
    seedDb({ withTokenUsage: true, tokenHasCost: false });
    insertTokens([{ agentId: 'main', createdAt: todaySec }], false);
    const out = await cfg().pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.todayCost).toBeUndefined();
    expect(main.todayTurns).toBe(1);
  });
});

describe('default isProcessAlive (C-24,C-42)', () => {
  it('ESRCH => false, EPERM => true, no throw (C-24,C-42)', async () => {
    seedDb();
    writePid('main', '1234');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 1000 } }));

    const orig = process.kill;
    try {
      // EPERM: process exists, not ours => alive
      (process as { kill: typeof process.kill }).kill = ((_pid: number, _sig?: string | number) => {
        const e = new Error('eperm') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      }) as typeof process.kill;
      let out = await createCcosNativeAdapter({
        dbPath: fixtureDbPath(),
        storeDir: dir,
        credentialsPath: join(dir, '.credentials.json'),
        agentIds: ['main'],
        now: () => NOW,
        // use the DEFAULT isProcessAlive (do not inject)
      }).pull();
      expect(out.statuses[0].status).toBe('up');

      // ESRCH: no such process => dead
      (process as { kill: typeof process.kill }).kill = ((_pid: number, _sig?: string | number) => {
        const e = new Error('esrch') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }) as typeof process.kill;
      out = await createCcosNativeAdapter({
        dbPath: fixtureDbPath(),
        storeDir: dir,
        credentialsPath: join(dir, '.credentials.json'),
        agentIds: ['main'],
        now: () => NOW,
      }).pull();
      expect(out.statuses[0].status).toBe('down');
    } finally {
      process.kill = orig;
    }
  });
});

describe('no scheduler export (C-26)', () => {
  it('module exports only the factory (no poll/loop) (C-26)', async () => {
    const mod = await import('../src/fleet/adapters/ccos-native.js');
    const exported = Object.keys(mod);
    expect(exported).toContain('createCcosNativeAdapter');
    expect(exported.some((k) => /loop|poll|schedule|start/i.test(k))).toBe(false);
  });
});

describe('source style (C-29)', () => {
  it("no em-dashes, .js imports, no ': any' (C-29)", () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'fleet', 'adapters', 'ccos-native.ts'),
      'utf-8',
    );
    expect(src.includes('—')).toBe(false); // em-dash
    expect(src.includes('–')).toBe(false); // en-dash
    expect(/:\s*any\b/.test(src)).toBe(false);
    // every relative import ends with .js
    const imports = src.match(/from\s+"(\.[^"]+)"/g) ?? [];
    for (const imp of imports) expect(imp.endsWith('.js"')).toBe(true);
  });
});

describe('round-1 finding fixes (C-48,C-49,C-50,C-51)', () => {
  it('most-recent-N and lastSeen use NORMALIZED ms ordering: a recent seconds row outranks an older ms row (C-48)', async () => {
    seedDb();
    // An OLD ms row (large raw int) vs a NEWER seconds row (small raw int).
    // Real times: ms row = yesterday; seconds row = today (newer in reality).
    const oldMsRow = startOfToday - 5 * 3600_000; // yesterday-ish, ms, big raw int
    const newSecRow = todaySec; // today 09:00, seconds, small raw int
    insertHive([
      { agentId: 'main', summary: 'old-ms', createdAt: oldMsRow },
      { agentId: 'main', summary: 'new-sec', createdAt: newSecRow },
    ]);
    const out = await cfg({ eventLimit: 1 }).pull();
    const mainEvents = out.events.filter((e) => e.agentId === 'main');
    // With a raw-unit ORDER BY bug, "old-ms" (big int) would win. Normalized, "new-sec" wins.
    expect(mainEvents).toHaveLength(1);
    expect(mainEvents[0].summary).toBe('new-sec');
    // lastSeen must be the newer (seconds) row, normalized to ms.
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.lastSeen).toBe(newSecRow * 1000);
  });

  it("PID file must be a strict integer: '123abc' does NOT report up (C-49)", async () => {
    seedDb();
    writePid('main', '123abc');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 1000 } }));
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).not.toBe('up');
    expect(['down', 'oauth-expired']).toContain(main.status);
  });

  it('idle boundary is inclusive: activity exactly idleMs old reports idle, not up (C-50)', async () => {
    seedDb();
    const idleMs = 15 * 60 * 1000;
    insertHive([{ agentId: 'main', summary: 'edge', createdAt: NOW - idleMs }]);
    writePid('main', '1234');
    const out = await cfg({ isProcessAlive: () => true, idleMs }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).toBe('idle');
  });

  it("an unreadable PID file (a directory at the PID path) is NOT clean 'unknown' (C-51)", async () => {
    seedDb();
    // Make the PID path a DIRECTORY: readFileSync throws EISDIR (not ENOENT).
    mkdirSync(join(dir, 'claudeclaw.pid'));
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 1000 } }));
    const out = await cfg({ isProcessAlive: () => true }).pull();
    const main = out.statuses.find((s) => s.agentId === 'main')!;
    expect(main.status).not.toBe('unknown');
    expect(['down', 'oauth-expired']).toContain(main.status);
    expect((main.detail ?? '').toLowerCase()).toContain('unreadable');
  });
});

describe('integration via runSync (C-43)', () => {
  it('writes fixture-derived agents/statuses/events into the ops store (C-43)', async () => {
    seedDb();
    insertHive([
      {
        agentId: 'main',
        action: 'send',
        summary: 'did a thing',
        createdAt: recentMs,
      },
    ]);
    insertTokens([{ agentId: 'main', cost: 0.42, createdAt: todaySec }]);
    writePid('main', '1234');
    writeCreds(JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 3600_000 } }));

    const ops = openOpsDb(':memory:');
    const adapter = cfg({ isProcessAlive: () => true });
    const results = await runSync(ops, [adapter], { now: () => NOW });

    expect(results[0].ok).toBe(true);
    expect(results[0].agents).toBe(4);

    const fleet = getFleet(ops, 'ccos');
    expect(fleet.map((r) => r.agentKey)).toContain('ccos:main');
    const main = fleet.find((r) => r.agentKey === 'ccos:main')!;
    expect(main.name).toBe('Data');
    expect(main.status).toBe('up');

    const activity = getActivity(ops, { source: 'ccos' });
    expect(activity.some((e) => e.summary === 'did a thing')).toBe(true);
    ops.close();
  });
});

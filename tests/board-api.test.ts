// Tests for src/fleet/board-api.ts (FIX B).
//
// Seeds a real temp ops db on disk (so the read-only fileMustExist open works),
// points MATRIX_OPS_DB at it, and drives the Hono app via app.request(). Covers
// auth fail-closed, 401s, env-path use, read-only no-write, validation/clamping,
// agentKey parameterization, duplicate-param proofing, and missing-db handling.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyOpsSchema } from '../src/ops/schema.js';
import { upsertAgent, upsertStatus, ingestEvents } from '../src/ops/queries.js';
import {
  clampLimit,
  createBoardApp,
  parseSource,
  resolveOpsDbPath,
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
} from '../src/fleet/board-api.js';

const GOOD = 's3cret-token';

let dir: string;
let opsPath: string;
const savedEnv: Record<string, string | undefined> = {};

function seedOps(path: string): void {
  const db = new Database(path);
  applyOpsSchema(db);
  upsertAgent(db, { source: 'ccos', agentId: 'main', name: 'Data', model: 'opus' }, 1000);
  upsertAgent(db, { source: 'cmd', agentId: 'research', name: 'Soundwave', model: 'sonnet' }, 1000);
  upsertStatus(db, { source: 'ccos', agentId: 'main', status: 'up' }, 1000);
  upsertStatus(db, { source: 'cmd', agentId: 'research', status: 'idle' }, 1000);
  const events = [];
  for (let i = 0; i < 120; i++) {
    events.push({
      source: 'ccos' as const,
      agentId: 'main',
      action: 'run',
      summary: `evt-${i}`,
      createdAt: 10000 + i,
    });
  }
  ingestEvents(db, events);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-api-'));
  opsPath = join(dir, 'matrix-ops.db');
  seedOps(opsPath);
  savedEnv.MATRIX_OPS_DB = process.env.MATRIX_OPS_DB;
  savedEnv.MATRIX_OPS_TRUSTED_ROOT = process.env.MATRIX_OPS_TRUSTED_ROOT;
  savedEnv.FLEET_DASHBOARD_TOKEN = process.env.FLEET_DASHBOARD_TOKEN;
  savedEnv.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
  process.env.MATRIX_OPS_DB = opsPath;
  // The temp dir is the trusted root for these tests (ops db lives directly in it).
  process.env.MATRIX_OPS_TRUSTED_ROOT = dir;
  process.env.FLEET_DASHBOARD_TOKEN = GOOD;
  delete process.env.DASHBOARD_TOKEN;
});

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('clampLimit handles bad / boundary inputs (C-19, C-53)', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('')).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('0')).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('-5')).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('abc')).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('1e9')).toBe(DEFAULT_ACTIVITY_LIMIT);
    expect(clampLimit('99999')).toBe(MAX_ACTIVITY_LIMIT);
    expect(clampLimit('2')).toBe(2);
  });

  it('parseSource validates against the known set (C-20, C-55)', () => {
    expect(parseSource(undefined)).toEqual({ ok: true });
    expect(parseSource('ccos')).toEqual({ ok: true, source: 'ccos' });
    expect(parseSource('admin').ok).toBe(false);
    expect(parseSource('corpus').ok).toBe(false);
    expect(parseSource('../store/matrix').ok).toBe(false);
    expect(parseSource("'; DROP TABLE agent_status; --").ok).toBe(false);
  });

  it('resolveOpsDbPath uses env, defaults to matrix-ops.db (C-09)', () => {
    // A non-existent path inside its declared trusted root returns the literal.
    expect(
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/x/matrix-ops.db',
        MATRIX_OPS_TRUSTED_ROOT: '/x',
      }),
    ).toBe('/x/matrix-ops.db');
    // Default (no env): the repo store/ trusted root + store/matrix-ops.db.
    expect(resolveOpsDbPath({})).toMatch(/matrix-ops\.db$/);
  });
});

describe('GET /api/fleet', () => {
  it('returns non-empty JSON with a valid token (C-07, C-09)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  it('401s on missing token (C-17)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/fleet`);
    expect(res.status).toBe(401);
  });

  it('401s on wrong token (C-17)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=nope`);
    expect(res.status).toBe(401);
  });

  it('401s on empty token (C-51)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=`);
    expect(res.status).toBe(401);
  });

  it('fails closed when no token configured (C-16)', async () => {
    delete process.env.FLEET_DASHBOARD_TOKEN;
    delete process.env.DASHBOARD_TOKEN;
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=anything`);
    expect(res.status).toBe(401);
  });

  it('rejects duplicate-token bypass in both orders (C-27, C-50)', async () => {
    const app = createBoardApp();
    const r1 = await app.request(`/api/fleet?token=wrong&token=${GOOD}`);
    const r2 = await app.request(`/api/fleet?token=${GOOD}&token=wrong`);
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });

  it('honors the DASHBOARD_TOKEN fallback (C-14)', async () => {
    delete process.env.FLEET_DASHBOARD_TOKEN;
    process.env.DASHBOARD_TOKEN = 'fb';
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=fb`);
    expect(res.status).toBe(200);
  });

  it('rejects an unknown source (C-20, C-40, C-55)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}&source=admin`);
    expect(res.status).toBe(400);
  });

  it('does not write the ops db (read-only) (C-11)', async () => {
    const before = statSync(opsPath);
    const app = createBoardApp();
    await app.request(`/api/fleet?token=${GOOD}`);
    await app.request(`/api/activity?token=${GOOD}`);
    const after = statSync(opsPath);
    expect(after.size).toBe(before.size);
    // No sidecar WAL/journal created by a read-only open.
    expect(existsSync(`${opsPath}-wal`)).toBe(false);
    expect(existsSync(`${opsPath}-journal`)).toBe(false);
  });
});

describe('GET /api/activity', () => {
  it('returns non-empty JSON, bounded by default (C-08, C-38)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/activity?token=${GOOD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(DEFAULT_ACTIVITY_LIMIT);
  });

  it('clamps an oversized limit (C-19, C-53)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/activity?token=${GOOD}&limit=99999`);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeLessThanOrEqual(MAX_ACTIVITY_LIMIT);
    // we seeded 120 events; MAX is 500, so all 120 come back, not unbounded > MAX
    expect(body.length).toBe(120);
  });

  it('honors a duplicate limit without unbounded read (C-54)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/activity?token=${GOOD}&limit=2&limit=99999`);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeLessThanOrEqual(MAX_ACTIVITY_LIMIT);
  });

  it('parameterizes agentKey: injection returns empty, no error (C-21, C-56)', async () => {
    const app = createBoardApp();
    const inj = encodeURIComponent("x' OR '1'='1");
    const res = await app.request(`/api/activity?token=${GOOD}&agentKey=${inj}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(0);
  });

  it('rejects an unknown source (C-20)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/activity?token=${GOOD}&source=bogus`);
    expect(res.status).toBe(400);
  });

  it('treats a whitespace-only agentKey as absent (no filter) (C-68)', async () => {
    const app = createBoardApp();
    // Baseline: no agentKey -> full (default-bounded) result.
    const baseRes = await app.request(`/api/activity?token=${GOOD}`);
    const base = (await baseRes.json()) as unknown[];
    expect(base.length).toBe(DEFAULT_ACTIVITY_LIMIT);

    // Whitespace-only agentKey must behave identically (trimmed -> absent), NOT
    // filter to a literal "   " key (which would return 0).
    const wsRes = await app.request(
      `/api/activity?token=${GOOD}&agentKey=${encodeURIComponent('   ')}`,
    );
    expect(wsRes.status).toBe(200);
    const ws = (await wsRes.json()) as unknown[];
    expect(ws.length).toBe(base.length);
  });

  it('handles BOTH an invalid source AND a bad limit safely (C-40)', async () => {
    const app = createBoardApp();
    // Invalid source is rejected first with 400; no crash, no 500, no unbounded
    // read despite the bad limit.
    const res = await app.request(`/api/activity?token=${GOOD}&source=bogus&limit=99999`);
    expect(res.status).toBe(400);
  });

  it('handles a valid source with a bad limit by defaulting safely (C-40b)', async () => {
    const app = createBoardApp();
    const res = await app.request(`/api/activity?token=${GOOD}&source=ccos&limit=abc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    // Bad limit -> default; bounded, never unbounded.
    expect(body.length).toBeLessThanOrEqual(MAX_ACTIVITY_LIMIT);
  });
});

describe('missing ops db (C-23, C-60)', () => {
  it('fails gracefully and never creates the db', async () => {
    const missing = join(dir, 'absent-matrix-ops.db');
    process.env.MATRIX_OPS_DB = missing;
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}`);
    expect(res.status).toBe(503);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('GET / honesty under outage (C-66)', () => {
  it('a missing ops db renders an explicit error state, NOT a healthy board', async () => {
    const missing = join(dir, 'absent-matrix-ops.db');
    process.env.MATRIX_OPS_DB = missing;
    const app = createBoardApp();
    const res = await app.request(`/?token=${GOOD}`);
    // Must NOT be a misleading healthy 200 board.
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('unavailable');
    expect(html).not.toContain('id="fleet-grid"');
    expect(existsSync(missing)).toBe(false);
  });

  it('a reachable but EMPTY ops db renders the normal (empty) board with 200 (C-66b)', async () => {
    // Seed an empty-but-valid ops db (schema only, no rows). basename must be
    // matrix-ops.db for the allowlist, so use a fresh subdir.
    const sub = mkdtempSync(join(tmpdir(), 'board-empty-'));
    const okPath = join(sub, 'matrix-ops.db');
    const seed = new Database(okPath);
    applyOpsSchema(seed);
    seed.close();
    process.env.MATRIX_OPS_DB = okPath;
    process.env.MATRIX_OPS_TRUSTED_ROOT = sub;
    try {
      const app = createBoardApp();
      const res = await app.request(`/?token=${GOOD}`);
      // The open SUCCEEDED -> normal board, even though it has no rows.
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="fleet-grid"');
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

describe('ops-failure observability (C-78)', () => {
  it('a 503 logs route + path + trusted root + error, and NEVER the token', async () => {
    const missing = join(dir, 'absent-matrix-ops.db');
    process.env.MATRIX_OPS_DB = missing;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createBoardApp();
      const res = await app.request(`/api/fleet?token=${GOOD}`);
      expect(res.status).toBe(503);
      // Exactly one ops-failure log line, carrying the triage fields.
      const joined = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(joined).toContain('GET /api/fleet');
      expect(joined).toContain(missing);
      expect(joined.toLowerCase()).toContain('trustedroot');
      // The dashboard token must NEVER appear in any log line.
      expect(joined).not.toContain(GOOD);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('misrouted MATRIX_OPS_DB is REFUSED, not opened read-only (C-59)', () => {
  it('a claudeclaw path env yields a non-success response, never a 200 board', async () => {
    process.env.MATRIX_OPS_DB = '/opt/claudeclaw-os/store/claudeclaw.db';
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}`);
    // Allowlist throws -> route maps to 503; NOT a read-only open, NOT a 200.
    expect(res.status).toBe(503);
  });

  it('a claudeclaw path env on GET / yields the error state, never a healthy board (C-59, C-66)', async () => {
    process.env.MATRIX_OPS_DB = '/opt/claudeclaw-os/store/claudeclaw.db';
    const app = createBoardApp();
    const res = await app.request(`/?token=${GOOD}`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain('id="fleet-grid"');
  });
});

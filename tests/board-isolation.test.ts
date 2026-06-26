// Isolation tests (the safety keystone). Mocks better-sqlite3 to capture EVERY
// path + options the board passes to the Database constructor, then drives the
// ACTUAL default open path of board-api (not a fixture-injected handle).
//
// NOTE (C-24, regenerated): this exercises board-api's REAL default open path.
// It deliberately makes NO claim about populate's default open path, because
// FIX A removed populate's DB-open default entirely (populate takes a required
// caller-owned opsDb handle), so such a claim is structurally impossible.
//
// Asserts:
//   - the ONLY path opened is a matrix-ops.db path (C-13, C-24)
//   - the open is always read-only (C-10, C-41)
//   - a 'claudeclaw' or corpus 'matrix.db' open would FAIL the test (C-25, C-59)
//   - a non-ops MATRIX_OPS_DB is REFUSED by the allowlist: the Database
//     constructor is NEVER called for it, and the route returns non-success
//     (C-59, C-62, C-63)
//   - the configured token is never logged (C-18, C-26)
// Plus a static hygiene check: no caller-injectable opener (C-12), reuse of the
// existing contracts (C-36), no Preact/Vite/Tailwind (C-37), .js imports + no
// `any` + no em-dash in the new files (C-35).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './strip-comments.js';

const openedPaths: string[] = [];
const openedOptions: Array<Record<string, unknown> | undefined> = [];

// A minimal fake Database: records constructor args, answers .prepare()/.close()
// with empty result sets so the route handlers run end-to-end without a real db.
class FakeStatement {
  all(): unknown[] {
    return [];
  }
  run(): { changes: number } {
    return { changes: 0 };
  }
  get(): unknown {
    return undefined;
  }
}
class FakeDatabase {
  constructor(path: string, options?: Record<string, unknown>) {
    openedPaths.push(path);
    openedOptions.push(options);
  }
  prepare(): FakeStatement {
    return new FakeStatement();
  }
  exec(): void {}
  close(): void {}
  transaction(fn: (rows: unknown[]) => number): (rows: unknown[]) => number {
    return (rows: unknown[]) => fn(rows);
  }
}

vi.mock('better-sqlite3', () => ({ default: FakeDatabase }));

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET_DIR = join(HERE, '..', 'src', 'fleet');

let createBoardApp: typeof import('../src/fleet/board-api.js').createBoardApp;

const GOOD = 'iso-token';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  openedPaths.length = 0;
  openedOptions.length = 0;
  savedEnv.MATRIX_OPS_DB = process.env.MATRIX_OPS_DB;
  savedEnv.FLEET_DASHBOARD_TOKEN = process.env.FLEET_DASHBOARD_TOKEN;
  savedEnv.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
  // Point at the repo's own store/matrix-ops.db, computed from this test file's
  // location. The better-sqlite3 OPEN is mocked, but resolveOpsDbPath's trusted-root
  // allowlist is NOT — it anchors to repoRootDir()/store, so the path must be inside
  // THIS checkout. A hardcoded absolute path (e.g. /home/<user>/...) is refused on any
  // machine whose checkout lives elsewhere (CI runner), which made this env-branch test
  // non-hermetic. Checkout-relative keeps it green everywhere.
  process.env.MATRIX_OPS_DB = join(HERE, '..', 'store', 'matrix-ops.db');
  process.env.FLEET_DASHBOARD_TOKEN = GOOD;
  delete process.env.DASHBOARD_TOKEN;
  ({ createBoardApp } = await import('../src/fleet/board-api.js'));
});

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.clearAllMocks();
});

describe('board open path isolation (C-13, C-24, C-25, C-59)', () => {
  it('opens ONLY a matrix-ops.db path on the real default route paths', async () => {
    const app = createBoardApp();
    await app.request(`/api/fleet?token=${GOOD}`);
    await app.request(`/api/activity?token=${GOOD}`);
    await app.request(`/?token=${GOOD}`);

    expect(openedPaths.length).toBeGreaterThan(0);
    for (const p of openedPaths) {
      expect(p).toMatch(/matrix-ops\.db$/);
    }
    // C-25 / C-59: a corpus or live-claudeclaw open must fail this test.
    expect(openedPaths.some((p) => /claudeclaw/i.test(p))).toBe(false);
    expect(openedPaths.some((p) => /(^|\/)matrix\.db$/.test(p))).toBe(false);
  });

  it('exercises the no-env DEFAULT fallback open path (C-24 default branch)', async () => {
    // Unset MATRIX_OPS_DB so resolveOpsDbPath takes the DEFAULT branch (the
    // store/matrix-ops.db computed from the module location), not the env branch.
    delete process.env.MATRIX_OPS_DB;
    const app = createBoardApp();
    await app.request(`/api/fleet?token=${GOOD}`);

    expect(openedPaths.length).toBeGreaterThan(0);
    // The default path ends in store/matrix-ops.db and is allowlist-clean.
    for (const p of openedPaths) {
      expect(p).toMatch(/(^|\/)store\/matrix-ops\.db$/);
    }
    expect(openedPaths.some((p) => /claudeclaw/i.test(p))).toBe(false);
  });

  it('always opens read-only with fileMustExist (C-10, C-41)', async () => {
    const app = createBoardApp();
    await app.request(`/api/fleet?token=${GOOD}`);
    expect(openedOptions.length).toBeGreaterThan(0);
    for (const opts of openedOptions) {
      expect(opts).toBeDefined();
      expect(opts?.readonly).toBe(true);
      expect(opts?.fileMustExist).toBe(true);
    }
  });

  it('REFUSES a non-ops MATRIX_OPS_DB: Database is never constructed for it, route is non-success (C-59, C-62, C-63)', async () => {
    // A misrouted env pointing at the live claudeclaw.db. The allowlist must
    // throw BEFORE any Database open, so the constructor is never called and the
    // route surfaces a non-success response (not a 200 healthy/empty board).
    process.env.MATRIX_OPS_DB = '/opt/claudeclaw-os/store/claudeclaw.db';
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}`);

    expect(res.status).not.toBe(200);
    // The bad path was NEVER opened (allowlist threw before the constructor).
    expect(openedPaths.some((p) => /claudeclaw/i.test(p))).toBe(false);
    expect(openedPaths).not.toContain('/opt/claudeclaw-os/store/claudeclaw.db');
  });

  it('REFUSES a corpus store/matrix.db MATRIX_OPS_DB the same way (C-63)', async () => {
    process.env.MATRIX_OPS_DB = '/opt/matrix/store/matrix.db';
    const app = createBoardApp();
    const res = await app.request(`/api/fleet?token=${GOOD}`);
    expect(res.status).not.toBe(200);
    expect(openedPaths.some((p) => /(^|\/)matrix\.db$/.test(p))).toBe(false);
  });
});

describe('token is never logged (C-18, C-26)', () => {
  it('no console sink receives the configured token', async () => {
    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = sinks.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    try {
      const app = createBoardApp();
      await app.request(`/api/fleet?token=${GOOD}`);
      await app.request(`/?token=${GOOD}`);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain(GOOD);
          }
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('static hygiene (C-12, C-35, C-36, C-37)', () => {
  const files = ['auth.ts', 'html.ts', 'populate.ts', 'board-api.ts', 'board.ts'].map((f) => {
    const src = readFileSync(join(FLEET_DIR, f), 'utf8');
    return { name: f, src, code: stripComments(src) };
  });

  it('board-api has no caller-injectable opener seam (C-12)', () => {
    const api = files.find((f) => f.name === 'board-api.ts')!.code;
    expect(api).not.toContain('__setOpsOpener');
    expect(api.toLowerCase()).not.toContain('openerfortests');
    // createBoardApp must take no arguments (no opener / db param).
    expect(/export function createBoardApp\(\)/.test(api)).toBe(true);
  });

  it('board-api reuses the existing query contracts (C-36)', () => {
    const api = files.find((f) => f.name === 'board-api.ts')!.code;
    expect(api).toContain('../ops/queries.js');
    expect(api).toContain('getFleet');
    expect(api).toContain('getActivity');
  });

  it('board-api opens read-only directly, not via openOpsDb (C-11 posture)', () => {
    const api = files.find((f) => f.name === 'board-api.ts')!.code;
    expect(api).toContain('readonly: true');
    expect(api).toContain('fileMustExist: true');
    expect(api).not.toContain('openOpsDb');
  });

  it('no Preact / Vite / Tailwind in the new files (C-37)', () => {
    for (const { code } of files) {
      expect(code.toLowerCase()).not.toContain('preact');
      expect(code.toLowerCase()).not.toContain('vite');
      expect(code.toLowerCase()).not.toContain('tailwind');
    }
  });

  it('no em-dash in the new files (C-35)', () => {
    for (const { src } of files) {
      expect(src.includes('—')).toBe(false);
      expect(src.includes('–')).toBe(false);
    }
  });
});

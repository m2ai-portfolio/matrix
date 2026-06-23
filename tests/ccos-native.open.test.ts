// Matrix Fleet Visibility - ccos-native OPEN-MODE proof (mocked constructor).
//
// This file mocks the better-sqlite3 module so it can observe the EXACT call the
// production code path makes: there is no injectable opener on the public API
// (removed in round 3 to close the "caller can override opener" finding), so the
// only honest way to prove read-only + only-the-configured-path is to watch the
// real constructor. Kept in its own file so the behavior suite can use a real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Records of every better-sqlite3 construction during a test.
interface OpenCall {
  path: string;
  options: unknown;
}
const opens: OpenCall[] = [];
let closeCount = 0;

// The fake "rows" a prepared statement returns, swappable per test.
type FakeRows = {
  get: (...p: unknown[]) => unknown;
  all: (...p: unknown[]) => unknown[];
};
// Default: every table looks ABSENT so pull() takes the empty-but-valid path.
let prepareImpl: (sql: string) => FakeRows = () => ({
  get: () => undefined,
  all: () => [],
});

// A class so `new Database(path, options)` always works as a constructor.
class FakeDatabase {
  constructor(path: string, options: unknown) {
    opens.push({ path, options });
  }
  prepare(sql: string): FakeRows {
    return prepareImpl(sql);
  }
  close(): void {
    closeCount += 1;
  }
}

vi.mock('better-sqlite3', () => ({ default: FakeDatabase }));

// Import AFTER the mock is registered (vi.mock is hoisted).
const { createCcosNativeAdapter } = await import('../src/fleet/adapters/ccos-native.js');

const NOW = 1_000_000_000_000;

beforeEach(() => {
  opens.length = 0;
  closeCount = 0;
  prepareImpl = () => ({ get: () => undefined, all: () => [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('production open mode (mocked constructor) (C-44,C-45,C-46,C-47)', () => {
  it('opens with { readonly: true, fileMustExist: true } (C-44,C-45)', async () => {
    await createCcosNativeAdapter({
      dbPath: '/tmp/fake/claudeclaw.db',
      storeDir: '/tmp/fake',
      agentIds: ['main'],
      now: () => NOW,
      isProcessAlive: () => false,
    }).pull();
    expect(opens).toHaveLength(1);
    expect(opens[0].options).toEqual({ readonly: true, fileMustExist: true });
  });

  it('opens ONLY the configured dbPath, never the corpus (C-46)', async () => {
    await createCcosNativeAdapter({
      dbPath: '/tmp/fake/claudeclaw.db',
      storeDir: '/tmp/fake',
      agentIds: ['main', 'sheridan', 'galvatron'],
      now: () => NOW,
      isProcessAlive: () => false,
    }).pull();
    expect(opens.map((o) => o.path)).toEqual(['/tmp/fake/claudeclaw.db']);
    expect(opens.some((o) => o.path.includes('matrix.db'))).toBe(false);
    expect(opens.some((o) => o.path.includes('claudeclaw-os'))).toBe(false);
  });

  it('closes the handle exactly once per pull (C-47)', async () => {
    const adapter = createCcosNativeAdapter({
      dbPath: '/tmp/fake/claudeclaw.db',
      storeDir: '/tmp/fake',
      agentIds: ['main'],
      now: () => NOW,
      isProcessAlive: () => false,
    });
    await adapter.pull();
    expect(closeCount).toBe(1);
    await adapter.pull();
    expect(closeCount).toBe(2); // one more, no leak
  });

  it('a DB read fault (table present, data query throws) reports stale, not up (C-52)', async () => {
    // Existence + column checks succeed, but the per-agent DATA query throws
    // (SQLITE_BUSY / I/O class). The agent must NOT be reported up with empty
    // telemetry; it must surface a stale read-fault signal.
    prepareImpl = (sql: string) => {
      const s = sql.toLowerCase();
      if (s.includes('sqlite_master')) {
        return { get: () => ({ '1': 1 }), all: () => [] }; // table present
      }
      if (s.includes('pragma table_info')) {
        return {
          get: () => undefined,
          all: () => [
            { name: 'agent_id' },
            { name: 'created_at' },
            { name: 'cost_usd' },
            { name: 'action' },
            { name: 'summary' },
            { name: 'artifacts' },
          ],
        };
      }
      // The actual data SELECT throws.
      return {
        get: () => {
          throw new Error('SQLITE_BUSY');
        },
        all: () => {
          throw new Error('SQLITE_BUSY');
        },
      };
    };

    const out = await createCcosNativeAdapter({
      dbPath: '/tmp/fake/claudeclaw.db',
      storeDir: '/tmp/fake',
      agentIds: ['main'],
      now: () => NOW,
      isProcessAlive: () => true, // "alive" but a read fault must override
    }).pull();
    const main = out.statuses[0];
    expect(main.status).toBe('stale');
    expect((main.detail ?? '').toLowerCase()).toContain('read failed');
    // The ROOT error is surfaced for on-call triage (round-3 LOW fix).
    expect(main.detail ?? '').toContain('SQLITE_BUSY');
  });

  it('a throwing liveness probe surfaces a probe-error detail, not silent down (C-53)', async () => {
    // Real temp dir for the PID + credentials files; the DB is still mocked-absent.
    const dir = mkdtempSync(join(tmpdir(), 'ccos-open-'));
    try {
      writeFileSync(join(dir, 'claudeclaw.pid'), '4242');
      writeFileSync(
        join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 3_600_000 } }),
      );
      const out = await createCcosNativeAdapter({
        dbPath: '/tmp/fake/claudeclaw.db',
        storeDir: dir,
        credentialsPath: join(dir, '.credentials.json'),
        agentIds: ['main'],
        now: () => NOW,
        isProcessAlive: () => {
          throw new Error('kill EPERM weird');
        },
      }).pull();
      const main = out.statuses[0];
      expect(main.status).toBe('down'); // cannot prove alive, creds valid => down
      expect((main.detail ?? '').toLowerCase()).toContain('liveness probe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the public config has no opener field: a caller cannot inject one (C-44 hardening)', async () => {
    const sneaky = vi.fn();
    const configWithSneaky = {
      dbPath: '/tmp/fake/claudeclaw.db',
      storeDir: '/tmp/fake',
      agentIds: ['main'],
      now: () => NOW,
      isProcessAlive: () => false,
      openDb: sneaky,
    } as unknown as Parameters<typeof createCcosNativeAdapter>[0];
    await createCcosNativeAdapter(configWithSneaky).pull();
    expect(sneaky).not.toHaveBeenCalled();
    expect(opens).toHaveLength(1); // the real (mocked) constructor was used
  });
});

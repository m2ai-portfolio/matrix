// Tests for src/fleet/populate.ts (FIX A).
//
// Proves: runPopulate(opsDb, adapters, opts?) writes via the sync engine and
// returns SyncResult; adapters is required; exitCode is 1 only when ALL sources
// fail; and the module has NO live-source default (no createCcosNativeAdapter,
// no claudeclaw / matrix.db reference).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyOpsSchema } from '../src/ops/schema.js';
import { getActivity, getFleet } from '../src/ops/queries.js';
import { runPopulate } from '../src/fleet/populate.js';
import type { FleetAdapter, FleetPull } from '../src/fleet/adapter.js';
import { stripComments } from './strip-comments.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POPULATE_SRC = join(HERE, '..', 'src', 'fleet', 'populate.ts');

function memoryOpsDb(): Database.Database {
  const db = new Database(':memory:');
  applyOpsSchema(db);
  return db;
}

function fixtureAdapter(pull: FleetPull): FleetAdapter {
  return {
    source: pull.agents[0]?.source ?? 'ccos',
    pull: () => Promise.resolve(pull),
  };
}

const samplePull: FleetPull = {
  agents: [
    { source: 'ccos', agentId: 'main', name: 'Data', model: 'opus' },
    { source: 'ccos', agentId: 'star', name: 'Starscream', model: 'sonnet' },
  ],
  statuses: [
    { source: 'ccos', agentId: 'main', status: 'up', todayTurns: 5 },
    { source: 'ccos', agentId: 'star', status: 'idle', todayTurns: 0 },
  ],
  events: [
    {
      source: 'ccos',
      agentId: 'main',
      action: 'run',
      summary: 'a',
      createdAt: 1000,
    },
    {
      source: 'ccos',
      agentId: 'main',
      action: 'run',
      summary: 'b',
      createdAt: 2000,
    },
    {
      source: 'ccos',
      agentId: 'star',
      action: 'post',
      summary: 'c',
      createdAt: 3000,
    },
  ],
};

describe('runPopulate writes + returns SyncResult (C-02)', () => {
  it('writes agents/statuses/events and reports counts', async () => {
    const db = memoryOpsDb();
    const out = await runPopulate(db, [fixtureAdapter(samplePull)], {
      log: () => {},
      now: () => 9999,
    });

    expect(out.results).toHaveLength(1);
    const r = out.results[0];
    expect(r.ok).toBe(true);
    expect(r.agents).toBe(2);
    expect(r.statuses).toBe(2);
    expect(r.newEvents).toBe(3);

    expect(getFleet(db)).toHaveLength(2);
    expect(getActivity(db, {})).toHaveLength(3);
    db.close();
  });
});

describe('adapters parameter is required (C-03)', () => {
  it('accepts an empty list as nothing-to-do (exitCode 0)', async () => {
    const db = memoryOpsDb();
    const out = await runPopulate(db, [], { log: () => {} });
    expect(out.exitCode).toBe(0);
    expect(out.results).toHaveLength(0);
    db.close();
  });

  it('signature requires opsDb and adapters (arity >= 2)', () => {
    // runPopulate(opsDb, adapters, opts?) - the two leading args are required.
    expect(runPopulate.length).toBeGreaterThanOrEqual(2);
  });
});

describe('exitCode kill posture (C-06)', () => {
  it('returns 1 only when every source fails', async () => {
    const db = memoryOpsDb();
    const failing: FleetAdapter = {
      source: 'ccos',
      pull: () => Promise.reject(new Error('boom')),
    };
    const failing2: FleetAdapter = {
      source: 'cmd',
      pull: () => Promise.reject(new Error('boom2')),
    };
    const out = await runPopulate(db, [failing, failing2], { log: () => {} });
    expect(out.exitCode).toBe(1);
    db.close();
  });

  it('returns 0 when at least one source succeeds', async () => {
    const db = memoryOpsDb();
    const failing: FleetAdapter = {
      source: 'cmd',
      pull: () => Promise.reject(new Error('boom')),
    };
    const out = await runPopulate(db, [fixtureAdapter(samplePull), failing], {
      log: () => {},
    });
    expect(out.exitCode).toBe(0);
    db.close();
  });
});

describe('no live-source default (C-04, C-05)', () => {
  // Assert against CODE only; comments legitimately name the forbidden tokens to
  // document their absence (see strip-comments.ts).
  const code = stripComments(readFileSync(POPULATE_SRC, 'utf8'));

  it('does not construct or import the ccos-native adapter (C-04)', () => {
    expect(code).not.toContain('createCcosNativeAdapter');
    expect(code).not.toContain('ccos-native');
  });

  it('references no claudeclaw path and no corpus matrix.db (C-05)', () => {
    expect(code.toLowerCase()).not.toContain('claudeclaw');
    expect(/[^-]matrix\.db/.test(code)).toBe(false);
  });
});

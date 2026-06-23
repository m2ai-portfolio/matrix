// Tests for the live populate entrypoint wiring (subtask 9).
//
// These exercise the CLI parsing, the adapter factory gate, and one full
// populate pass against an in-memory ops DB with a FAKE adapter — never a live
// path. Read-only-ness of the real ccos adapter is proven in ccos-native.test.ts
// (it mocks better-sqlite3 to assert readonly:true); here we only prove the
// wiring writes the ops store and is idempotent.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { FleetAdapter, FleetPull } from './adapter.js';
import { parseSources, buildAdapters, populateOnce, DEFAULT_SOURCES } from './populate-ccos.js';

/** A deterministic in-memory adapter returning a fixed pull. */
function fakeAdapter(pull: FleetPull): FleetAdapter {
  return { source: 'ccos', pull: async () => pull };
}

const SAMPLE: FleetPull = {
  agents: [{ source: 'ccos', agentId: 'main', name: 'Data', ownerHuman: 'the owner' }],
  statuses: [
    { source: 'ccos', agentId: 'main', status: 'up', detail: 'alive', lastSeen: 1_700_000_000_000 },
  ],
  events: [
    {
      source: 'ccos',
      agentId: 'main',
      action: 'reply',
      summary: 'hello',
      createdAt: 1_700_000_000_000,
    },
    {
      source: 'ccos',
      agentId: 'main',
      action: 'reply',
      summary: 'world',
      createdAt: 1_700_000_001_000,
    },
  ],
};

describe('parseSources', () => {
  it('defaults to ccos when no flag', () => {
    expect(parseSources([])).toEqual(DEFAULT_SOURCES);
    expect(parseSources(['some', 'noise'])).toEqual(['ccos']);
  });

  it('accepts --source ccos and --source=ccos', () => {
    expect(parseSources(['--source', 'ccos'])).toEqual(['ccos']);
    expect(parseSources(['--source=ccos'])).toEqual(['ccos']);
    expect(parseSources(['-s', 'ccos'])).toEqual(['ccos']);
  });

  it('accepts comma lists and repeated flags, preserving order and de-duping', () => {
    expect(parseSources(['--source=ccos,cmd'])).toEqual(['ccos', 'cmd']);
    expect(parseSources(['--source', 'ccos', '--source', 'hermes'])).toEqual(['ccos', 'hermes']);
    expect(parseSources(['--source=ccos,ccos'])).toEqual(['ccos']);
  });

  it('throws on an unknown source', () => {
    expect(() => parseSources(['--source=bogus'])).toThrow(/unknown --source 'bogus'/);
  });
});

describe('buildAdapters', () => {
  it('builds the ccos adapter', () => {
    const adapters = buildAdapters(['ccos']);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].source).toBe('ccos');
  });

  it('throws for a known-but-unimplemented source (forward-compat guard)', () => {
    expect(() => buildAdapters(['cmd'])).toThrow(/no adapter implemented for source 'cmd'/);
    expect(() => buildAdapters(['hermes'])).toThrow(/available: ccos/);
  });
});

describe('populateOnce', () => {
  it('writes the ops store from an injected adapter', async () => {
    // populateOnce opens and closes its own handle, so :memory: (per-connection)
    // wouldn't be observable from a second handle — use a temp file instead.
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/matrix-ops-test-${process.pid}-${Math.floor(performance.now())}.db`;
    const outcome = await populateOnce({
      adapters: [fakeAdapter(SAMPLE)],
      opsDbPath: tmp,
      log: () => {},
    });
    expect(outcome.exitCode).toBe(0);

    const db = new Database(tmp, { readonly: true });
    try {
      const agents = db.prepare('SELECT COUNT(*) c FROM agent_registry').get() as { c: number };
      const statuses = db.prepare('SELECT COUNT(*) c FROM agent_status').get() as { c: number };
      const events = db.prepare('SELECT COUNT(*) c FROM activity_event').get() as { c: number };
      expect(agents.c).toBe(1);
      expect(statuses.c).toBe(1);
      expect(events.c).toBe(2);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second identical pass adds zero new events', async () => {
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/matrix-ops-idem-${process.pid}-${Math.floor(performance.now())}.db`;

    const first = await populateOnce({
      adapters: [fakeAdapter(SAMPLE)],
      opsDbPath: tmp,
      log: () => {},
    });
    const second = await populateOnce({
      adapters: [fakeAdapter(SAMPLE)],
      opsDbPath: tmp,
      log: () => {},
    });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const db = new Database(tmp, { readonly: true });
    try {
      const agents = db.prepare('SELECT COUNT(*) c FROM agent_registry').get() as { c: number };
      const events = db.prepare('SELECT COUNT(*) c FROM activity_event').get() as { c: number };
      // upsert keeps one registry row; dedupe index keeps two unique events.
      expect(agents.c).toBe(1);
      expect(events.c).toBe(2);
      // The second pass reported zero NEW events.
      expect(second.results[0].newEvents).toBe(0);
    } finally {
      db.close();
    }
  });

  it('exitCode is 1 only when every source fails', async () => {
    const throwing: FleetAdapter = {
      source: 'ccos',
      pull: async () => {
        throw new Error('boom');
      },
    };
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/matrix-ops-fail-${process.pid}-${Math.floor(performance.now())}.db`;
    const outcome = await populateOnce({ adapters: [throwing], opsDbPath: tmp, log: () => {} });
    expect(outcome.exitCode).toBe(1);
  });
});

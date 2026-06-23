// Matrix Fleet Visibility — operational lane + sync engine tests.
// In-memory DB only; the real store is never touched.

import { describe, it, expect } from 'vitest';
import { openOpsDb } from '../src/ops/open.js';
import { applyOpsSchema } from '../src/ops/schema.js';
import {
  upsertAgent,
  upsertStatus,
  ingestEvents,
  getFleet,
  getActivity,
  markSourceStale,
} from '../src/ops/queries.js';
import { runSync } from '../src/fleet/sync.js';
import { agentKey, type FleetAdapter, type FleetPull } from '../src/fleet/adapter.js';

const T0 = 1_700_000_000_000;

describe('ops schema', () => {
  it('applies idempotently and creates the three tables', () => {
    const db = openOpsDb(':memory:');
    expect(() => applyOpsSchema(db)).not.toThrow(); // second apply
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('agent_registry');
    expect(tables).toContain('agent_status');
    expect(tables).toContain('activity_event');
  });
});

describe('registry + status upsert', () => {
  it('joins registry with status and updates in place (no duplicate rows)', () => {
    const db = openOpsDb(':memory:');
    upsertAgent(db, { source: 'ccos', agentId: 'main', name: 'Data', ownerHuman: 'the owner' }, T0);
    upsertStatus(db, { source: 'ccos', agentId: 'main', status: 'up', todayTurns: 5 }, T0);

    let fleet = getFleet(db);
    expect(fleet).toHaveLength(1);
    expect(fleet[0].agentKey).toBe('ccos:main');
    expect(fleet[0].name).toBe('Data');
    expect(fleet[0].status).toBe('up');
    expect(fleet[0].todayTurns).toBe(5);
    expect(fleet[0].lastSeen).toBe(T0); // stamped from `now` when omitted

    // Re-sync the same agent with new status: still one row, updated value.
    upsertStatus(db, { source: 'ccos', agentId: 'main', status: 'idle', todayTurns: 9 }, T0 + 1000);
    fleet = getFleet(db);
    expect(fleet).toHaveLength(1);
    expect(fleet[0].status).toBe('idle');
    expect(fleet[0].todayTurns).toBe(9);
  });

  it('filters the fleet by source', () => {
    const db = openOpsDb(':memory:');
    upsertAgent(db, { source: 'ccos', agentId: 'main' }, T0);
    upsertAgent(db, { source: 'cmd', agentId: 'research' }, T0);
    expect(getFleet(db, 'cmd').map((r) => r.agentKey)).toEqual(['cmd:research']);
  });
});

describe('activity ingest', () => {
  it('is idempotent: identical events collapse, count stays stable', () => {
    const db = openOpsDb(':memory:');
    const events = [
      {
        source: 'ccos' as const,
        agentId: 'main',
        action: 'send_email',
        summary: 'replied to Greg',
        createdAt: T0,
      },
      {
        source: 'ccos' as const,
        agentId: 'main',
        action: 'write_file',
        summary: 'drafted note',
        createdAt: T0 + 1,
      },
    ];
    expect(ingestEvents(db, events)).toBe(2);
    expect(ingestEvents(db, events)).toBe(0); // re-run inserts nothing
    expect(getActivity(db)).toHaveLength(2);
  });

  it('filters activity by source and by agent, newest first', () => {
    const db = openOpsDb(':memory:');
    ingestEvents(db, [
      {
        source: 'ccos',
        agentId: 'main',
        action: 'a',
        summary: 'old',
        createdAt: T0,
      },
      {
        source: 'ccos',
        agentId: 'main',
        action: 'b',
        summary: 'new',
        createdAt: T0 + 10,
      },
      {
        source: 'cmd',
        agentId: 'research',
        action: 'c',
        summary: 'other',
        createdAt: T0 + 5,
      },
    ]);
    const ccos = getActivity(db, { source: 'ccos' });
    expect(ccos.map((e) => e.summary)).toEqual(['new', 'old']); // DESC by time
    expect(ccos.every((e) => e.source === 'ccos')).toBe(true);

    const oneAgent = getActivity(db, { agentKey: agentKey('cmd', 'research') });
    expect(oneAgent).toHaveLength(1);
    expect(oneAgent[0].agentId).toBe('research'); // round-trips from agent_key
  });
});

// Minimal adapter doubles for the sync engine.
function mockAdapter(source: 'ccos' | 'cmd', pull: FleetPull): FleetAdapter {
  return { source, pull: async () => pull };
}
function failingAdapter(source: 'ccos' | 'cmd', message: string): FleetAdapter {
  return {
    source,
    pull: async () => {
      throw new Error(message);
    },
  };
}

describe('runSync', () => {
  it('writes a healthy adapter into the ops store', async () => {
    const db = openOpsDb(':memory:');
    const adapter = mockAdapter('cmd', {
      agents: [
        {
          source: 'cmd',
          agentId: 'research',
          name: 'Soundwave',
          ownerHuman: 'Noah',
        },
      ],
      statuses: [{ source: 'cmd', agentId: 'research', status: 'up', todayCost: 0.42 }],
      events: [
        {
          source: 'cmd',
          agentId: 'research',
          action: 'web-search',
          summary: 'signal scan',
          createdAt: T0,
        },
      ],
    });

    const results = await runSync(db, [adapter], { now: () => T0 });
    expect(results).toEqual([{ source: 'cmd', ok: true, agents: 1, statuses: 1, newEvents: 1 }]);

    const fleet = getFleet(db);
    expect(fleet[0].name).toBe('Soundwave');
    expect(fleet[0].status).toBe('up');
    expect(getActivity(db)).toHaveLength(1);
  });

  it('isolates failure: a throwing source goes stale, others stay healthy, no throw', async () => {
    const db = openOpsDb(':memory:');
    // Seed cmd agents so the failure path has something to mark stale.
    upsertAgent(db, { source: 'cmd', agentId: 'research' }, T0);
    upsertStatus(db, { source: 'cmd', agentId: 'research', status: 'up' }, T0);

    const good = mockAdapter('ccos', {
      agents: [{ source: 'ccos', agentId: 'main' }],
      statuses: [{ source: 'ccos', agentId: 'main', status: 'up' }],
      events: [],
    });
    const bad = failingAdapter('cmd', 'connection refused');

    const results = await runSync(db, [good, bad], { now: () => T0 + 500 });

    const ccos = results.find((r) => r.source === 'ccos')!;
    const cmd = results.find((r) => r.source === 'cmd')!;
    expect(ccos.ok).toBe(true);
    expect(cmd.ok).toBe(false);
    expect(cmd.error).toContain('connection refused');

    // The failed source's existing agent is now stale; the healthy one is up.
    const byKey = Object.fromEntries(getFleet(db).map((r) => [r.agentKey, r.status]));
    expect(byKey['ccos:main']).toBe('up');
    expect(byKey['cmd:research']).toBe('stale');
  });
});

describe('markSourceStale', () => {
  it('marks every agent of a source stale', () => {
    const db = openOpsDb(':memory:');
    upsertStatus(db, { source: 'hermes', agentId: 'greg', status: 'up' }, T0);
    upsertStatus(db, { source: 'hermes', agentId: 'peer-agent', status: 'idle' }, T0);
    markSourceStale(db, 'hermes', 'portainer unreachable', T0 + 1);
    expect(getFleet(db, 'hermes').every((r) => r.status === 'stale')).toBe(true);
  });
});

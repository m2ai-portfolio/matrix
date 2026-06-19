// Matrix -> CCOS bridge tests (docs/ROUTING.md §"The bridge").
//
// CCOS mission API is MOCKED — no live claudeclaw.db, no real mission-cli, no
// network. Covers: mission-cli output parsing, the bridge writes nothing under
// claudeclaw-os, claim -> enqueue -> simulated completion -> result card, and an
// idempotent re-run that adds zero new cards / re-enqueues nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneDirs, makeCard, readCardFile, writeCardFile } from '../src/queue/card.js';
import { parseCreate, parseResult, type MissionApi } from '../src/bridge/mission.js';
import { bridgePass } from '../src/bridge/bridge.js';
import { runBridgeLoop, BRIDGE_LOOP_GUARDS } from '../src/bridge/loop.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'matrix-bridge-'));
  const { tasks, claimed, results } = laneDirs(root);
  for (const d of [tasks, claimed, results]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function dropForGalvatron(id = 'T-20260615-0001') {
  const { tasks } = laneDirs(root);
  const card = makeCard({
    id,
    title: 'summarize the Atlantic thread',
    owner: 'galvatron',
    requester: 'data',
    action: 'Summarize the thread into 5 bullets.',
    doneWhen: '5 bullets returned to data.',
    now: new Date(2026, 5, 15),
  });
  writeCardFile(join(tasks, `${id}.md`), card);
  return card;
}

/** A mock MissionApi that records calls and lets the test drive completion. */
function mockMission() {
  const created: Array<{ agent: string; title: string; prompt: string }> = [];
  let resultState: {
    status: string;
    result: string | null;
    error: string | null;
  } = {
    status: 'queued',
    result: null,
    error: null,
  };
  let counter = 0;
  const api: MissionApi = {
    async create(input) {
      created.push(input);
      counter += 1;
      return { id: `ccos-${counter}` };
    },
    async result(id) {
      return { id, ...resultState };
    },
  };
  return {
    api,
    created,
    complete(result: string) {
      resultState = { status: 'completed', result, error: null };
    },
    fail() {
      resultState = { status: 'failed', result: null, error: 'boom' };
    },
  };
}

describe('mission-cli output parsing', () => {
  it('parses a create line', () => {
    expect(parseCreate('Mission task created: a1b2c3d4\n  Title: x').id).toBe('a1b2c3d4');
  });
  it('parses a completed result with a Result block', () => {
    const stdout =
      'Task:   a1b2 [completed]\nTitle:  x\nAgent:  galvatron\n\nResult:\nthe answer\nmore';
    const r = parseResult(stdout, 'a1b2');
    expect(r.status).toBe('completed');
    expect(r.result).toBe('the answer\nmore');
    expect(r.error).toBeNull();
  });
  it('parses a queued result with no result yet', () => {
    const r = parseResult('Task:   a1b2 [queued]\nTitle:  x\nAgent:  g\n\nNo result yet.', 'a1b2');
    expect(r.status).toBe('queued');
    expect(r.result).toBeNull();
  });
});

describe('bridge isolation', () => {
  it('the loop wrapper declares real owner/sink/kill guards', () => {
    expect(BRIDGE_LOOP_GUARDS.owner).toBeTruthy();
    expect(BRIDGE_LOOP_GUARDS.sink).toBeTruthy();
    expect(BRIDGE_LOOP_GUARDS.kill).toBeTruthy();
    for (const v of Object.values(BRIDGE_LOOP_GUARDS)) {
      expect(['', 'none', 'tbd', '-']).not.toContain(String(v).toLowerCase());
    }
  });

  it('writes no files under the claudeclaw-os tree (mock API touches no FS)', async () => {
    const ccosDir = '/opt/claudeclaw-os';
    const before = existsSync(ccosDir) ? snapshot(ccosDir) : null;
    dropForGalvatron();
    const m = mockMission();
    await bridgePass(root, 'galvatron', m.api);
    if (before) {
      expect(snapshot(ccosDir)).toEqual(before);
    }
    // All bridge writes landed under the Matrix queue root, never elsewhere.
    expect(existsSync(join(root, 'tasks', 'claimed'))).toBe(true);
  });
});

describe('bridge claim -> enqueue -> complete -> result', () => {
  it('enqueues via the sanctioned mission API exactly once, then returns a result card', async () => {
    const card = dropForGalvatron();
    const m = mockMission();

    // Pass 1: claim + enqueue.
    const p1 = await bridgePass(root, 'galvatron', m.api, { now: () => 1000 });
    expect(p1.outcome).toBe('enqueued');
    expect(p1.ccosTaskId).toBe('ccos-1');
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({
      agent: 'galvatron',
      title: card.title,
      prompt: card.action,
    });

    // Still queued -> pass 2 is pending (no double enqueue).
    const p2 = await bridgePass(root, 'galvatron', m.api, { now: () => 1100 });
    expect(p2.outcome).toBe('pending');
    expect(m.created).toHaveLength(1); // NOT re-enqueued

    // Complete in CCOS, pass 3 returns the result to the results/ lane.
    m.complete('FIVE BULLETS');
    const p3 = await bridgePass(root, 'galvatron', m.api, { now: () => 1200 });
    expect(p3.outcome).toBe('completed');
    expect(m.created).toHaveLength(1);

    const { results } = laneDirs(root);
    const resultFiles = readdirSync(results).filter((n) => n.endsWith('.md'));
    expect(resultFiles).toHaveLength(1);
    const resultCard = readCardFile(join(results, resultFiles[0]));
    expect(resultCard.owner).toBe('data'); // addressed to the requester
    expect(resultCard.result).toBe('FIVE BULLETS');
  });
});

describe('end-to-end via the loop (CCOS mocked)', () => {
  it('drops a galvatron card, loop enqueues + returns a result card, re-run adds zero', async () => {
    dropForGalvatron('T-20260615-0001');
    const m = mockMission();
    m.complete('DONE'); // mock returns completed immediately

    const passes = await runBridgeLoop({
      queueRoot: root,
      agentId: 'galvatron',
      mission: m.api,
      now: () => 1000,
    });
    // The loop runs claim+enqueue then, on the next pass, sees completed and returns.
    expect(passes.map((p) => p.outcome)).toContain('completed');
    expect(m.created).toHaveLength(1);

    const { results } = laneDirs(root);
    const after1 = readdirSync(results).filter((n) => n.endsWith('.md'));
    expect(after1).toHaveLength(1);

    // Idempotent re-run: nothing claimable, no new mission, no new result card.
    const passes2 = await runBridgeLoop({
      queueRoot: root,
      agentId: 'galvatron',
      mission: m.api,
      now: () => 2000,
    });
    expect(passes2.every((p) => p.outcome === 'idle')).toBe(true);
    expect(m.created).toHaveLength(1); // no re-enqueue
    const after2 = readdirSync(results).filter((n) => n.endsWith('.md'));
    expect(after2).toEqual(after1); // zero new cards
  });

  it('a failed CCOS task at kill blocks the card and escalates (no result card)', async () => {
    const { tasks } = laneDirs(root);
    const card = makeCard({
      id: 'T-20260615-0009',
      title: 'flaky',
      owner: 'galvatron',
      requester: 'data',
      action: 'do it',
      doneWhen: 'done',
      kill: 1, // one attempt, claim makes attempts=1 == kill
      now: new Date(2026, 5, 15),
    });
    writeCardFile(join(tasks, `${card.id}.md`), card);

    const m = mockMission();
    await bridgePass(root, 'galvatron', m.api, { now: () => 1000 }); // enqueue, attempts=1
    m.fail();
    const p = await bridgePass(root, 'galvatron', m.api, { now: () => 1100 });
    expect(p.outcome).toBe('blocked');

    const { claimed, results } = laneDirs(root);
    const blocked = readCardFile(join(claimed, `${card.id}.galvatron.md`));
    expect(blocked.status).toBe('blocked');
    expect(blocked.notes).toContain('escalate to data');
    expect(readdirSync(results).filter((n) => n.endsWith('.md'))).toHaveLength(0);
  });
});

/** Cheap recursive snapshot of a directory tree (names only) for isolation checks. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      out.push(p);
      if (name.isDirectory() && name.name !== 'node_modules' && name.name !== '.git') {
        walk(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

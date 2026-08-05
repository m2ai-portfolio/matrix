// Fleet-memory MCP logic tests — injected fake embedder, temp DB, zero network.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import { initVec, EMBED_DIM, vecCount } from '../src/db/vec.js';
import type { Embedder } from '../src/embed/embedder.js';
import { search, remember, recent, FLEET_SOURCE } from '../src/mcp/memory.js';

// Deterministic fake: unit vector whose direction is derived from the first chars,
// so identical texts are nearest neighbours and different texts diverge.
const fakeEmbedder: Embedder = async (text: string) => {
  const v = new Array(EMBED_DIM).fill(0);
  for (let i = 0; i < Math.min(text.length, 64); i++) {
    v[(text.charCodeAt(i) * 31 + i) % EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

describe('fleet memory (mcp logic)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    initVec(db);
  });

  it('remember writes turn + embedding + vec row in the fleet lane', async () => {
    const m = await remember(db, fakeEmbedder, {
      agent: 'ravage',
      text: 'skill-forge CI flakes on push races; rebase before retry',
      topic: 'ci',
      now: () => '2026-08-04T00:00:00.000Z',
    });
    expect(m.turn_id).toMatch(/^fm-/);
    const row = db
      .prepare(
        'SELECT source, source_id, project, content FROM conversation_turn WHERE turn_id = ?',
      )
      .get(m.turn_id) as Record<string, string>;
    expect(row.source).toBe(FLEET_SOURCE);
    expect(row.source_id).toBe('ravage');
    expect(row.project).toBe('ci');
    expect(vecCount(db)).toBe(1);
  });

  it('remember is idempotent per (agent, text)', async () => {
    const input = { agent: 'data', text: 'the same fact', now: () => '2026-08-04T00:00:00.000Z' };
    const a = await remember(db, fakeEmbedder, input);
    const b = await remember(db, fakeEmbedder, input);
    expect(a.turn_id).toBe(b.turn_id);
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_turn WHERE source = ?')
      .get(FLEET_SOURCE) as { n: number };
    expect(n.n).toBe(1);
    expect(vecCount(db)).toBe(1);
    const e = db
      .prepare('SELECT COUNT(*) AS n FROM embedding WHERE turn_id = ?')
      .get(a.turn_id) as { n: number };
    expect(e.n).toBe(1);
  });

  it('search finds a remembered fact and can filter by source lane', async () => {
    await remember(db, fakeEmbedder, {
      agent: 'soundwave',
      text: 'orbi mesh drops 5GHz backhaul on firmware 9.2',
      now: () => '2026-08-04T00:00:00.000Z',
    });
    await remember(db, fakeEmbedder, {
      agent: 'kup',
      text: 'pm2 frozen env: delete/start/save to refresh',
      now: () => '2026-08-04T00:00:01.000Z',
    });
    const hits = await search(db, 'orbi mesh drops 5GHz backhaul on firmware 9.2', fakeEmbedder, {
      k: 1,
      source: FLEET_SOURCE,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('orbi mesh');
    expect(hits[0].source).toBe(FLEET_SOURCE);
  });

  it('recent returns newest-first and filters by agent', async () => {
    await remember(db, fakeEmbedder, {
      agent: 'a1',
      text: 'older',
      now: () => '2026-08-01T00:00:00.000Z',
    });
    await remember(db, fakeEmbedder, {
      agent: 'a2',
      text: 'newer',
      now: () => '2026-08-03T00:00:00.000Z',
    });
    const all = recent(db, 10);
    expect(all.map((r) => r.content)).toEqual(['newer', 'older']);
    expect(recent(db, 10, 'a1').map((r) => r.content)).toEqual(['older']);
  });

  it('remember rejects wrong-dim embedders (dim guard)', async () => {
    const bad: Embedder = async () => [1, 2, 3];
    await expect(remember(db, bad, { agent: 'x', text: 'y' })).rejects.toThrow(/dim/);
  });
});

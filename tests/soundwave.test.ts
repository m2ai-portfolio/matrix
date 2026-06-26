// Tests for the Soundwave article-grade connector (Option A mapping + enrich-before-embed).
//
// Hermetic: a synthetic LoadResult + an injected fake fetch exercise the transform, the
// enrichment success/fallback paths, the stable-id invariant, and the gated live ingest
// against an in-memory DB. ZERO network, ZERO live store/matrix.db access.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';
import {
  gradeToTurn,
  gradeToTurnEnriched,
  enrichContent,
  fetchArticle,
  htmlToText,
  inCronWindow,
  ingestLive,
  SOURCE,
  ROLE,
  type Grade,
  type SeenEntry,
  type LoadResult,
} from '../src/connectors/soundwave.js';

const grade: Grade = {
  id: 'venturebeat-376e2b67',
  title: 'Krea 2 Raw and Turbo available as open weights',
  tag: 'discovered',
  verdict: 'down',
  notes: 'Not actionable - outside of our stack',
  ts: '2026-06-23T22:33:39.292981Z',
  batch: '2026-06-23',
  source: 'venturebeat.com',
};
const seen: SeenEntry = { url: 'https://venturebeat.com/krea-2', title: grade.title };

/** Build a Response-shaped fake for the injected fetch. */
function fakeFetch(
  handler: (url: string) => { ok: boolean; status: number; body: string },
): typeof globalThis.fetch {
  return (async (url: string) => {
    const { ok, status, body } = handler(String(url));
    return { ok, status, text: async () => body } as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('gradeToTurn (Option A mapping)', () => {
  it('maps grade fields into a conversation_turn with meta JSON', () => {
    const t = gradeToTurn(grade, seen);
    expect(t.source).toBe(SOURCE);
    expect(t.role).toBe(ROLE);
    expect(t.source_id).toBe(grade.id);
    expect(t.conversation_id).toBe('2026-06-23');
    expect(t.content).toBe(`${grade.title}\n\n${grade.notes}`);
    const meta = JSON.parse(t.meta) as Record<string, unknown>;
    expect(meta.verdict).toBe('down');
    expect(meta.url).toBe(seen.url);
    expect(meta.domain).toBe('venturebeat.com');
    expect(meta.tag).toBe('discovered');
  });
});

describe('htmlToText', () => {
  it('drops script/style, strips tags, decodes entities, collapses whitespace', () => {
    const html =
      '<html><head><style>.a{color:red}</style></head><body>' +
      '<script>evil()</script><h1>Fish &amp; Chips</h1>\n\n<p>Hello   world</p></body></html>';
    expect(htmlToText(html)).toBe('Fish & Chips Hello world');
  });
  it('caps at the limit with an ellipsis', () => {
    expect(htmlToText('<p>' + 'x'.repeat(50) + '</p>', 10)).toBe('xxxxxxxxx…');
  });
});

describe('fetchArticle', () => {
  it('retries a 503 then returns the body on success', async () => {
    let calls = 0;
    const fn = fakeFetch(() => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 503, body: '' }
        : { ok: true, status: 200, body: '<p>ok</p>' };
    });
    const body = await fetchArticle('https://x', fn, 2, [0, 0]);
    expect(body).toBe('<p>ok</p>');
    expect(calls).toBe(2);
  });
  it('throws on a permanent 404', async () => {
    const fn = fakeFetch(() => ({ ok: false, status: 404, body: '' }));
    await expect(fetchArticle('https://x', fn, 2, [0, 0])).rejects.toThrow('HTTP 404');
  });
});

describe('enrichContent', () => {
  it('folds the article body into content on success', async () => {
    const fn = fakeFetch(() => ({ ok: true, status: 200, body: '<p>Full article body here.</p>' }));
    const r = await enrichContent(grade, seen, fn);
    expect(r.fellBack).toBe(false);
    expect(r.content).toContain(grade.title);
    expect(r.content).toContain('Full article body here.');
  });
  it('falls back to title+notes (NOT skipped) when the fetch fails', async () => {
    const fn = fakeFetch(() => ({ ok: false, status: 500, body: '' }));
    const r = await enrichContent(grade, seen, fn);
    expect(r.fellBack).toBe(true);
    expect(r.content).toBe(gradeToTurn(grade, seen).content);
  });
  it('falls back when there is no url', async () => {
    const fn = fakeFetch(() => ({ ok: true, status: 200, body: '<p>never reached</p>' }));
    const r = await enrichContent(grade, undefined, fn);
    expect(r.fellBack).toBe(true);
    expect(r.content).toBe(gradeToTurn(grade, undefined).content);
  });
});

describe('gradeToTurnEnriched stable identity', () => {
  it('keeps the title+notes turn_id even when content carries the body', () => {
    const base = gradeToTurn(grade, seen);
    const enriched = gradeToTurnEnriched(grade, seen, `${base.content}\n\nBODY DRIFT`);
    expect(enriched.turn_id).toBe(base.turn_id); // identity is the grade, not the volatile body
    expect(enriched.content).toContain('BODY DRIFT');
  });
});

describe('inCronWindow', () => {
  it('halts inside 05:00-07:00 CT and clears outside it', () => {
    // 06:30 CDT = 11:30 UTC; 08:30 CDT = 13:30 UTC (June = CDT, UTC-5).
    expect(inCronWindow(new Date('2026-06-26T11:30:00Z'))).toBe(true);
    expect(inCronWindow(new Date('2026-06-26T13:30:00Z'))).toBe(false);
  });
});

describe('ingestLive (gated)', () => {
  const load: LoadResult = {
    total: 1,
    soundwaveGrades: [grade],
    otherLaneCount: 0,
    seen: { [grade.id]: seen },
    urlMatched: 1,
    urlCoverage: 1,
  };

  it('HALTs without opening the DB inside the cron window', async () => {
    const r = await ingestLive({ load, now: new Date('2026-06-26T11:30:00Z') });
    expect(r.halted).toBe(true);
    expect(r.liveDbOpened).toBe(false);
    expect(r.reason).toContain('cron window');
  });

  it('writes enriched rows outside the window and is idempotent', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const fn = fakeFetch(() => ({ ok: true, status: 200, body: '<p>Body text.</p>' }));
    const opts = { db, load, fetchFn: fn, now: new Date('2026-06-26T13:30:00Z') };

    const first = await ingestLive(opts);
    expect(first.halted).toBe(false);
    expect(first.inserted).toBe(1);
    expect(first.enriched).toBe(1);
    expect(first.fellBack).toEqual([]);
    const row = db
      .prepare("SELECT content FROM conversation_turn WHERE source='soundwave'")
      .get() as { content: string };
    expect(row.content).toContain('Body text.');

    const second = await ingestLive(opts); // re-run: stable id -> 0 new rows
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    db.close();
  });

  it('records a dead-url grade as fallback instead of dropping it', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    // 404 is non-retryable -> fails fast (a retryable 503 would burn the real 2s+5s backoff).
    const fn = fakeFetch(() => ({ ok: false, status: 404, body: '' }));
    const r = await ingestLive({
      db,
      load,
      fetchFn: fn,
      now: new Date('2026-06-26T13:30:00Z'),
    });
    expect(r.inserted).toBe(1); // still written
    expect(r.fellBack).toEqual([grade.id]);
    expect(r.enriched).toBe(0);
    db.close();
  });
});

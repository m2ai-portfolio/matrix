// Tests for src/fleet/html.ts - structure (card grid, activity feed, source
// filter) and HTML escaping of stored strings (no injection from summaries).

import { describe, expect, it } from 'vitest';
import { escapeHtml, renderBoardHtml, renderBoardError, ALL_SOURCES } from '../src/fleet/html.js';
import type { FleetRow } from '../src/ops/queries.js';
import type { ActivityEvent } from '../src/fleet/adapter.js';

const fleet: FleetRow[] = [
  {
    agentKey: 'ccos:main',
    source: 'ccos',
    agentId: 'main',
    name: 'Data',
    role: null,
    model: 'opus',
    provider: null,
    ownerHuman: 'the owner',
    endpoint: null,
    status: 'up',
    detail: 'running',
    todayTurns: 5,
    todayCost: 0.12,
    lastSeen: 1000,
  },
];

const activity: ActivityEvent[] = [
  {
    source: 'ccos',
    agentId: 'main',
    action: 'run',
    summary: 'ok',
    createdAt: 1,
  },
];

describe('escapeHtml (C-58)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('escapes ampersand first (no double-escaping)', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
});

describe('renderBoardHtml structure (C-28)', () => {
  const html = renderBoardHtml(fleet, activity, ALL_SOURCES);

  it('contains the card grid', () => {
    expect(html).toContain('id="fleet-grid"');
    expect(html).toContain('fleet-card');
  });

  it('contains the activity feed container', () => {
    expect(html).toContain('id="activity-feed"');
  });

  it('contains a source-filter control with each source', () => {
    expect(html).toContain('id="source-filter"');
    for (const s of ALL_SOURCES) {
      expect(html).toContain(`<option value="${s}">${s}</option>`);
    }
  });

  it('shows card fields (model, owner, turns, cost)', () => {
    expect(html).toContain('Data');
    expect(html).toContain('opus');
    expect(html).toContain('the owner');
    expect(html).toContain('today turns: 5');
  });
});

describe('renderBoardHtml escaping (C-29, C-57)', () => {
  it('escapes a malicious agent name', () => {
    const evil: FleetRow[] = [{ ...fleet[0], name: '<script>alert(1)</script>' }];
    const html = renderBoardHtml(evil, [], ALL_SOURCES);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes a malicious activity summary (C-57)', () => {
    const evil: ActivityEvent[] = [
      {
        source: 'ccos',
        agentId: 'main',
        summary: '"><img src=x onerror=alert(1)>',
        createdAt: 1,
      },
    ];
    const html = renderBoardHtml([], evil, ALL_SOURCES);
    expect(html).toContain('&quot;&gt;&lt;img');
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
  });
});

describe('token is NEVER embedded in served HTML (C-67)', () => {
  // renderBoardHtml takes NO token argument: there is no server-side token sink
  // in the page, so a malicious token cannot break out of the markup. The inline
  // JS reads ?token= from its OWN URL at runtime.
  it('renderBoardHtml has no token parameter (arity 3: fleet, activity, sources)', () => {
    expect(renderBoardHtml.length).toBe(3);
  });

  it('the served page reads the token from location.search, not from a server literal', () => {
    const html = renderBoardHtml(fleet, activity, ALL_SOURCES);
    expect(html).toContain('location.search');
    expect(html).toContain('URLSearchParams');
  });

  it("a '</script>' breakout token never appears in the page (no sink to break)", () => {
    // Even if an attacker could influence a token, the page is rendered WITHOUT
    // it, so the breakout payload can never reach the served HTML.
    const breakout = '</script><script>alert(1)</script>';
    const html = renderBoardHtml(fleet, activity, ALL_SOURCES);
    expect(html).not.toContain(breakout);
    // sanity: the only </script> in the page closes the legitimate inline block.
    expect(html.split('</script>').length).toBe(2);
  });
});

describe('renderBoardError (C-66)', () => {
  it('renders an explicit unavailable state, not a healthy board', () => {
    const html = renderBoardError();
    expect(html.toLowerCase()).toContain('unavailable');
    // It must NOT look like the populated board (no fleet grid / card markup).
    expect(html).not.toContain('id="fleet-grid"');
    expect(html).not.toContain('fleet-card');
  });
});

describe('client refresh surfaces fetch failures, not a fake-empty board (C-73)', () => {
  const html = renderBoardHtml(fleet, activity, ALL_SOURCES);

  it('the page carries an error element and a showError path', () => {
    expect(html).toContain('id="fleet-error"');
    expect(html).toContain('showError');
  });

  it('a non-2xx response throws inside fetchJson (no silent [] fallback)', () => {
    // The old code did `r.ok ? r.json() : []`, masking failures. The hardened
    // code throws on !r.ok so the catch renders the error banner.
    expect(html).toContain('if (!r.ok)');
    expect(html).toContain('throw new Error("request failed:');
    expect(html).not.toContain('r.ok ? r.json() : []');
  });

  it('the catch path calls showError, it does not blank the grid silently', () => {
    expect(html).toMatch(/catch\(function \(\) \{[\s\S]*showError/);
  });
});

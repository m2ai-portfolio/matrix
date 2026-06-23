// Matrix Fleet Visibility - board HTML rendering (docs/FLEET-VISIBILITY.md sec6/9).
//
// Single server-rendered page (no Preact/Vite/Tailwind - HARD #6 / sec9). The
// page holds: an agent card grid, an activity-feed container, and a source
// filter control. Inline JS re-fetches /api/fleet and /api/activity with the
// ?token= so the live view stays current without a build pipeline.
//
// SAFETY: every stored string (agent name/role/model/owner, status detail,
// activity action/summary) is HTML-escaped via escapeHtml before it lands in the
// markup, so a malicious summary cannot inject script (C-29/C-57/C-58).
//
// SAFETY (C-67): the dashboard token is NEVER embedded into the served page.
// There is no server-side token sink in the HTML, so a token containing
// '</script>' or a quote cannot break out of the markup. The inline JS reads
// ?token= from its OWN URL (location.search) at runtime for the live re-fetches.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import type { Source } from './adapter.js';
import type { FleetRow } from '../ops/queries.js';
import type { ActivityEvent } from './adapter.js';

/** All known sources, used to render the filter control. */
export const ALL_SOURCES: readonly Source[] = ['ccos', 'cmd', 'hermes', 'vendor'];

/**
 * Escape the five HTML-significant characters so stored strings render as text,
 * never as markup. & must be replaced first so the entity ampersands we emit are
 * not themselves double-escaped.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape any value (null/undefined -> empty string) for safe interpolation. */
function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value));
}

/** Render one agent status card. All dynamic fields are escaped. */
function renderCard(row: FleetRow): string {
  const status = row.status ?? 'unknown';
  const turns = row.todayTurns ?? 0;
  const cost = row.todayCost ?? 0;
  return [
    `<div class="fleet-card" data-status="${esc(status)}">`,
    `  <span class="status-dot status-${esc(status)}"></span>`,
    `  <div class="card-name">${esc(row.name ?? row.agentId)}</div>`,
    `  <div class="card-meta">model: ${esc(row.model)}</div>`,
    `  <div class="card-meta">owner: ${esc(row.ownerHuman)}</div>`,
    `  <div class="card-meta">today turns: ${esc(turns)}</div>`,
    `  <div class="card-meta">today cost: ${esc(cost)}</div>`,
    `  <div class="card-detail">${esc(row.detail)}</div>`,
    `</div>`,
  ].join('\n');
}

/** Render one activity feed row. */
function renderActivityRow(e: ActivityEvent): string {
  return [
    `<div class="activity-row" data-source="${esc(e.source)}">`,
    `  <span class="activity-source">${esc(e.source)}</span>`,
    `  <span class="activity-agent">${esc(e.agentId)}</span>`,
    `  <span class="activity-action">${esc(e.action)}</span>`,
    `  <span class="activity-summary">${esc(e.summary)}</span>`,
    `</div>`,
  ].join('\n');
}

/** Render the <select> source filter control. */
function renderSourceFilter(sources: readonly Source[]): string {
  const opts = ['<option value="">all sources</option>']
    .concat(sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`))
    .join('\n');
  return `<select id="source-filter" class="source-filter">\n${opts}\n</select>`;
}

/**
 * Render the full board page. The token is NEVER embedded into the page (C-67):
 * the inline JS reads ?token= from its own URL (location.search) at runtime for
 * the live re-fetches, so there is no server-side token sink to break out of.
 * The initial server render seeds the grid/feed so the page is useful even
 * before the inline refresh runs.
 */
export function renderBoardHtml(
  fleet: FleetRow[],
  activity: ActivityEvent[],
  sources: readonly Source[],
): string {
  const cards = fleet.map(renderCard).join('\n');
  const rows = activity.map(renderActivityRow).join('\n');
  const filter = renderSourceFilter(sources);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Matrix Fleet Board</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem; background: #0e1116; color: #e6edf3; }
  .controls { margin-bottom: 1rem; }
  .fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; }
  .fleet-card { border: 1px solid #30363d; border-radius: 8px; padding: 0.75rem; background: #161b22; }
  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #6e7681; margin-right: 6px; }
  .status-up { background: #2ea043; }
  .status-idle { background: #d29922; }
  .status-down { background: #f85149; }
  .status-oauth-expired { background: #db61a2; }
  .status-stale { background: #8b949e; }
  .card-name { font-weight: 600; }
  .card-meta, .card-detail { font-size: 0.8rem; color: #9da7b1; }
  .activity-feed { margin-top: 1.5rem; }
  .activity-row { border-bottom: 1px solid #21262d; padding: 0.4rem 0; font-size: 0.85rem; }
  .activity-source { color: #58a6ff; margin-right: 0.5rem; }
  .fleet-error { border: 1px solid #f85149; border-radius: 8px; padding: 0.6rem; margin-bottom: 0.75rem; background: #161b22; color: #f85149; }
</style>
</head>
<body>
<h1>Matrix Fleet Board</h1>
<div class="controls">
  ${filter}
</div>
<div id="fleet-error" class="fleet-error" data-state="ok" hidden></div>
<div id="fleet-grid" class="fleet-grid">
${cards}
</div>
<div id="activity-feed" class="activity-feed">
${rows}
</div>
<script>
(function () {
  // The token is read from THIS page's own URL (?token=), never embedded by the
  // server. No server-side token sink => no breakout vector (C-67).
  var TOKEN = new URLSearchParams(location.search).get("token") || "";
  var filter = document.getElementById("source-filter");
  function showError(msg) {
    var el = document.getElementById("fleet-error");
    if (!el) return;
    el.textContent = msg;
    el.setAttribute("data-state", "error");
    el.hidden = false;
  }
  function clearError() {
    var el = document.getElementById("fleet-error");
    if (!el) return;
    el.textContent = "";
    el.setAttribute("data-state", "ok");
    el.hidden = true;
  }
  // Fetch JSON, but surface a non-2xx or a network failure as an EXPLICIT error
  // state instead of silently rendering an empty fleet (which would mask an auth
  // or ops-DB outage on the live re-fetch).
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) {
        throw new Error("request failed: " + r.status);
      }
      return r.json();
    });
  }
  function refresh() {
    var src = filter ? filter.value : "";
    var fleetUrl = "/api/fleet?token=" + encodeURIComponent(TOKEN) + (src ? "&source=" + encodeURIComponent(src) : "");
    var actUrl = "/api/activity?token=" + encodeURIComponent(TOKEN) + (src ? "&source=" + encodeURIComponent(src) : "");
    Promise.all([fetchJson(fleetUrl), fetchJson(actUrl)]).then(function (res) {
      clearError();
      renderFleet(res[0]);
      renderActivity(res[1]);
    }).catch(function () {
      // Do NOT blank the board to a fake-empty state: tell the operator the
      // live data could not be loaded.
      showError("Could not load fleet status (request failed). The data shown may be stale.");
    });
  }
  function escapeText(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function renderFleet(rows) {
    var grid = document.getElementById("fleet-grid");
    grid.innerHTML = rows.map(function (row) {
      var status = row.status || "unknown";
      return '<div class="fleet-card" data-status="' + escapeText(status) + '">' +
        '<span class="status-dot status-' + escapeText(status) + '"></span>' +
        '<div class="card-name">' + escapeText(row.name || row.agentId) + '</div>' +
        '<div class="card-meta">model: ' + escapeText(row.model) + '</div>' +
        '<div class="card-meta">owner: ' + escapeText(row.ownerHuman) + '</div>' +
        '<div class="card-meta">today turns: ' + escapeText(row.todayTurns || 0) + '</div>' +
        '<div class="card-meta">today cost: ' + escapeText(row.todayCost || 0) + '</div>' +
        '<div class="card-detail">' + escapeText(row.detail) + '</div>' +
        '</div>';
    }).join("");
  }
  function renderActivity(rows) {
    var feed = document.getElementById("activity-feed");
    feed.innerHTML = rows.map(function (e) {
      return '<div class="activity-row" data-source="' + escapeText(e.source) + '">' +
        '<span class="activity-source">' + escapeText(e.source) + '</span>' +
        '<span class="activity-agent">' + escapeText(e.agentId) + '</span>' +
        '<span class="activity-action">' + escapeText(e.action) + '</span>' +
        '<span class="activity-summary">' + escapeText(e.summary) + '</span>' +
        '</div>';
    }).join("");
  }
  if (filter) filter.addEventListener("change", refresh);
  refresh();
})();
</script>
</body>
</html>`;
}

/**
 * Render an explicit error page for GET / when the ops DB is missing, unreadable,
 * or refused by the allowlist (C-66). This must NOT look like a healthy board:
 * it states the ops store is unavailable so an operator is never misled into
 * thinking the fleet is fine when the data source is down. Carries an
 * "ops store unavailable" marker the same shape as the API 503 body.
 */
export function renderBoardError(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Matrix Fleet Board - unavailable</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem; background: #0e1116; color: #e6edf3; }
  .error { border: 1px solid #f85149; border-radius: 8px; padding: 1rem; background: #161b22; color: #f85149; }
</style>
</head>
<body>
<h1>Matrix Fleet Board</h1>
<div class="error" data-state="error">
  ops store unavailable - the fleet status cannot be read right now.
</div>
</body>
</html>`;
}

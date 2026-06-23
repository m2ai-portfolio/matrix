// Matrix Fleet Visibility — operational-lane read/write queries.
//
// All DB access for the ops lane goes through here (house pattern: no raw SQL
// outside the db module). Writes are upserts/idempotent so a re-run of sync
// produces no duplicates (docs/FLEET-VISIBILITY.md §6 "Done when").

import type { Database } from 'better-sqlite3';
import {
  agentKey,
  type AgentRecord,
  type AgentStatus,
  type ActivityEvent,
  type Source,
  type Status,
} from '../fleet/adapter.js';

/** A fleet row as rendered on the board: registry joined with latest status. */
export interface FleetRow {
  agentKey: string;
  source: Source;
  agentId: string;
  name: string | null;
  role: string | null;
  model: string | null;
  provider: string | null;
  ownerHuman: string | null;
  endpoint: string | null;
  status: Status | null;
  detail: string | null;
  todayTurns: number | null;
  todayCost: number | null;
  lastSeen: number | null;
}

/** Upsert one agent's metadata (created_at preserved on conflict). */
export function upsertAgent(db: Database, a: AgentRecord, now: number): void {
  const key = agentKey(a.source, a.agentId);
  db.prepare(
    `INSERT INTO agent_registry
       (agent_key, source, agent_id, name, role, model, provider, owner_human, endpoint, created_at, updated_at)
     VALUES (@agent_key, @source, @agent_id, @name, @role, @model, @provider, @owner_human, @endpoint, @now, @now)
     ON CONFLICT(agent_key) DO UPDATE SET
       name = excluded.name,
       role = excluded.role,
       model = excluded.model,
       provider = excluded.provider,
       owner_human = excluded.owner_human,
       endpoint = excluded.endpoint,
       updated_at = excluded.updated_at`,
  ).run({
    agent_key: key,
    source: a.source,
    agent_id: a.agentId,
    name: a.name ?? null,
    role: a.role ?? null,
    model: a.model ?? null,
    provider: a.provider ?? null,
    owner_human: a.ownerHuman ?? null,
    endpoint: a.endpoint ?? null,
    now,
  });
}

/** Upsert one agent's latest status snapshot. */
export function upsertStatus(db: Database, s: AgentStatus, now: number): void {
  const key = agentKey(s.source, s.agentId);
  db.prepare(
    `INSERT INTO agent_status
       (agent_key, source, status, detail, today_turns, today_cost, last_seen, updated_at)
     VALUES (@agent_key, @source, @status, @detail, @today_turns, @today_cost, @last_seen, @now)
     ON CONFLICT(agent_key) DO UPDATE SET
       source = excluded.source,
       status = excluded.status,
       detail = excluded.detail,
       today_turns = excluded.today_turns,
       today_cost = excluded.today_cost,
       last_seen = excluded.last_seen,
       updated_at = excluded.updated_at`,
  ).run({
    agent_key: key,
    source: s.source,
    status: s.status,
    detail: s.detail ?? null,
    today_turns: s.todayTurns ?? null,
    today_cost: s.todayCost ?? null,
    last_seen: s.lastSeen ?? now,
    now,
  });
}

/**
 * Insert activity events idempotently. Identical events (same source, agent,
 * time, action, summary) collapse via the dedupe unique index. Returns the
 * number of NEW rows actually inserted.
 */
export function ingestEvents(db: Database, events: ActivityEvent[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO activity_event
       (source, agent_key, action, summary, artifacts, created_at)
     VALUES (@source, @agent_key, @action, @summary, @artifacts, @created_at)`,
  );
  const tx = db.transaction((rows: ActivityEvent[]) => {
    let inserted = 0;
    for (const e of rows) {
      const info = stmt.run({
        source: e.source,
        agent_key: agentKey(e.source, e.agentId),
        action: e.action ?? null,
        summary: e.summary ?? null,
        artifacts: e.artifacts ?? null,
        created_at: e.createdAt,
      });
      inserted += info.changes;
    }
    return inserted;
  });
  return tx(events);
}

/** The full fleet, registry left-joined to latest status, newest signal first. */
export function getFleet(db: Database, source?: Source): FleetRow[] {
  const where = source ? 'WHERE r.source = ?' : '';
  const rows = db
    .prepare(
      `SELECT r.agent_key AS agentKey, r.source, r.agent_id AS agentId, r.name, r.role,
              r.model, r.provider, r.owner_human AS ownerHuman, r.endpoint,
              s.status, s.detail, s.today_turns AS todayTurns, s.today_cost AS todayCost,
              s.last_seen AS lastSeen
         FROM agent_registry r
         LEFT JOIN agent_status s ON s.agent_key = r.agent_key
         ${where}
         ORDER BY s.last_seen DESC NULLS LAST, r.agent_key ASC`,
    )
    .all(...(source ? [source] : [])) as FleetRow[];
  return rows;
}

/** Recent activity, newest first, optionally filtered by source or one agent. */
export function getActivity(
  db: Database,
  opts: { limit?: number; source?: Source; agentKey?: string } = {},
): ActivityEvent[] {
  const limit = opts.limit ?? 50;
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.source) {
    clauses.push('source = ?');
    params.push(opts.source);
  }
  if (opts.agentKey) {
    clauses.push('agent_key = ?');
    params.push(opts.agentKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT source, agent_key AS agentKeyCol, action, summary, artifacts, created_at AS createdAt
         FROM activity_event
         ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    source: Source;
    agentKeyCol: string;
    action: string | null;
    summary: string | null;
    artifacts: string | null;
    createdAt: number;
  }>;

  // Re-derive agentId from the stored agent_key (`source:agentId`).
  return rows.map((r) => ({
    source: r.source,
    agentId: r.agentKeyCol.slice(r.source.length + 1),
    action: r.action ?? undefined,
    summary: r.summary ?? undefined,
    artifacts: r.artifacts ?? undefined,
    createdAt: r.createdAt,
  }));
}

/** Mark every agent of a source as `stale` — used when an adapter fails (§5 kill). */
export function markSourceStale(db: Database, source: Source, detail: string, now: number): void {
  db.prepare(
    `UPDATE agent_status SET status = 'stale', detail = @detail, updated_at = @now
       WHERE source = @source`,
  ).run({ source, detail, now });
}

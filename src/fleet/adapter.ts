// Matrix Fleet Visibility — the per-source adapter contract (docs/FLEET-VISIBILITY.md §4).
//
// Every runtime that wants to appear on the board implements one FleetAdapter.
// The sync engine (src/fleet/sync.ts) is the only caller; it never knows whether
// a source is a local DB read, a remote HTTP poll, or an export-staleness check.

import type { ActivityCategory } from './activity-taxonomy.js';

/** Known agent runtimes. Vendor = output-staleness only, never reports `up`. */
export type Source = 'ccos' | 'cmd' | 'hermes' | 'vendor';

/**
 * Operational status of an agent.
 * - up: actively reachable / working
 * - idle: reachable but doing nothing
 * - down: known-dead (process/container not running)
 * - oauth-expired: down specifically because an auth token lapsed (CCOS rotates ~8h)
 * - stale: last signal is old / source could not be reached this sync
 * - unknown: we have no live signal at all (typical for vendor agents)
 */
export type Status = 'up' | 'idle' | 'down' | 'oauth-expired' | 'stale' | 'unknown';

/** Static-ish metadata for one agent. `agent_id` is unique only within a source. */
export interface AgentRecord {
  source: Source;
  agentId: string;
  name?: string;
  role?: string;
  model?: string;
  provider?: string;
  ownerHuman?: string;
  endpoint?: string;
}

/** A point-in-time status snapshot for one agent. */
export interface AgentStatus {
  source: Source;
  agentId: string;
  status: Status;
  detail?: string;
  todayTurns?: number;
  todayCost?: number;
  /** Unix ms of the last real signal. Omit to let the sync engine stamp it. */
  lastSeen?: number;
}

/** A single activity-feed entry (hive_mind-shaped). */
export interface ActivityEvent {
  source: Source;
  agentId: string;
  action?: string;
  /** Activity category derived from `action` via the shared activity-taxonomy. */
  category?: ActivityCategory;
  summary?: string;
  /** Optional structured payload, JSON-stringified by the writer. */
  artifacts?: string;
  /** Unix ms the event happened. */
  createdAt: number;
}

/** What an adapter returns each pull. Agents/events may be empty. */
export interface FleetPull {
  agents: AgentRecord[];
  statuses: AgentStatus[];
  events: ActivityEvent[];
}

/** The contract every source implements. `pull()` is read-only by design. */
export interface FleetAdapter {
  readonly source: Source;
  pull(): Promise<FleetPull>;
}

/**
 * Canonical agent identity across the whole fleet.
 * `${source}:${agentId}` — e.g. "ccos:main", "cmd:research", "hermes:greg".
 */
export function agentKey(source: Source, agentId: string): string {
  return `${source}:${agentId}`;
}

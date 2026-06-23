// Matrix Fleet Visibility - the ccos-native adapter (docs/FLEET-VISIBILITY.md sec4/6/7).
//
// Reads the live ClaudeClaw-OS store READ-ONLY to surface the local agent fleet on
// the Matrix board. It never writes, migrates, or locks the live DB: four systemd
// agents (main/sheridan/galvatron/starscream) write claudeclaw.db in WAL mode, so
// the only handle this module ever holds is opened with
// `{ readonly: true, fileMustExist: true }` and closed in a finally block.
//
// Status is derived from PID liveness plus an OAuth-expiry classification, because
// CCOS rotates its Claude OAuth token roughly every 8h and a lapsed token
// silent-crashes an agent (see memory: data-canonical-on-claudeclaw-os).
//
// Every table and column read is defensive. The live schema drifts from the base
// CREATE statements (verified: token_usage gained an agent_id column by migration,
// and hive_mind.created_at holds a mix of unix-seconds and unix-ms rows), so a
// missing table or column yields empty or undefined rather than throwing. pull()
// throws only if the DB path itself cannot be opened read-only.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ActivityEvent,
  AgentRecord,
  AgentStatus,
  FleetAdapter,
  FleetPull,
  Status,
} from '../adapter.js';
import { categorizeAction } from '../activity-taxonomy.js';

/** All knobs are injectable so tests pass fixtures and never touch a live path. */
export interface CcosNativeConfig {
  /** Live store DB. Default ~/projects/claudeclaw-os/store/claudeclaw.db. */
  dbPath?: string;
  /** Where PID files live. Default dirname(dbPath). */
  storeDir?: string;
  /** OAuth credentials JSON. Default ~/.claude/.credentials.json. */
  credentialsPath?: string;
  /** Agents to report. Default the four live CCOS agents. */
  agentIds?: string[];
  /** Max activity events per agent. Default 20. */
  eventLimit?: number;
  /** An alive agent with no activity newer than this is reported idle. Default 15 min. */
  idleMs?: number;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
  /** Injectable liveness predicate. Default process.kill(pid, 0). */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * The read-only slice of a better-sqlite3 Database the adapter actually uses.
 * It exposes NO write method, so a TypeScript caller cannot write through the
 * handle the adapter holds.
 *
 * There is NO injectable opener on the public API: the adapter always opens via
 * the module-level better-sqlite3 with `{ readonly: true, fileMustExist: true }`.
 * A production caller therefore has no way to make the adapter open the live DB
 * read-write or open a different path. Tests assert the real open mode by mocking
 * the better-sqlite3 module (observing the actual constructor), not by injecting
 * an opener (which would itself be an attack surface). (round-3 HIGH fix.)
 */
export interface ReadonlyDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const DEFAULT_AGENT_IDS = ['main', 'sheridan', 'galvatron', 'starscream'];
const DEFAULT_EVENT_LIMIT = 20;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const MS_THRESHOLD = 1e12;

/** Open the store read-only. The ONLY throw site (un-openable dbPath). */
function openReadonly(path: string): ReadonlyDb {
  return new Database(path, {
    readonly: true,
    fileMustExist: true,
  }) as unknown as ReadonlyDb;
}

/** Default OAuth credentials location. */
function defaultCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/** Default live store DB path. */
function defaultDbPath(): string {
  return join(homedir(), 'projects', 'claudeclaw-os', 'store', 'claudeclaw.db');
}

/**
 * Default liveness check. `process.kill(pid, 0)` does not send a signal: it only
 * probes. ESRCH means no such process (dead). EPERM means the process exists but
 * is owned by another user (alive, just not ours). Any other error is treated as
 * not-alive. Never throws.
 *
 * Known limitation: PID liveness cannot detect a recycled PID, so a reused PID
 * can yield a false 'up'. This is an accepted property of PID-based liveness.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/** Title-case a single token: "sheridan" -> "Sheridan". */
function titleCase(id: string): string {
  if (id.length === 0) return id;
  return id[0].toUpperCase() + id.slice(1);
}

/** Display name per the spec map: main -> Data, others Title-cased. */
function displayName(id: string): string {
  return id === 'main' ? 'Data' : titleCase(id);
}

/** PID file path: main -> claudeclaw.pid, others -> agent-<id>.pid. */
function pidFilePath(storeDir: string, id: string): string {
  return join(storeDir, id === 'main' ? 'claudeclaw.pid' : `agent-${id}.pid`);
}

/** Does a table exist? Defensive: returns false on any error. */
function tableExists(db: ReadonlyDb, table: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table);
    return row !== undefined;
  } catch {
    return false;
  }
}

/** Does a column exist on a table? Defensive: returns false on any error. */
function columnExists(db: ReadonlyDb, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

/**
 * Three-way PID probe:
 * - `kind: 'absent'` -> no PID file (ENOENT). Maps to 'unknown' (no signal).
 * - `kind: 'error'`  -> the PID file exists but could not be read (EACCES/EIO).
 *                       This is NOT "no signal": we know a file is there, we just
 *                       cannot prove liveness, so it is treated as not-alive and
 *                       routed through the down/oauth classification with a detail,
 *                       never disguised as a clean 'unknown'.
 * - `kind: 'read'`   -> the file was read; `alive` is the liveness result.
 */
type PidProbe =
  | { kind: 'absent' }
  | { kind: 'error'; detail: string }
  | { kind: 'read'; alive: boolean; probeError?: string };

/** Strict positive integer: rejects "123abc", "", "-1"; trims first. */
function parseStrictPid(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function probePid(storeDir: string, id: string, isAlive: (pid: number) => boolean): PidProbe {
  let raw: string;
  try {
    raw = readFileSync(pidFilePath(storeDir, id), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    // EACCES / EIO / EISDIR / anything else: the file is there but unreadable.
    return {
      kind: 'error',
      detail: `PID file unreadable (${code ?? 'error'})`,
    };
  }
  const pid = parseStrictPid(raw);
  if (pid === null) {
    // File present but not a clean integer: treat as present-but-dead, never throw.
    return { kind: 'read', alive: false };
  }
  let alive: boolean;
  let probeError: string | undefined;
  try {
    alive = isAlive(pid);
  } catch (err) {
    // A throwing liveness probe is itself a fault: do not silently report dead.
    // Surface the cause in the detail so a probe bug is not mistaken for a crash.
    alive = false;
    probeError = `liveness probe failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { kind: 'read', alive, probeError };
}

/** OAuth state read defensively from the credentials file. */
interface OauthProbe {
  /** True only when we positively read a numeric expiresAt that is in the past. */
  expired: boolean;
  /** The expiresAt we read, if any (ms). */
  expiresAt?: number;
}

function probeOauth(credentialsPath: string, nowMs: number): OauthProbe {
  let text: string;
  try {
    text = readFileSync(credentialsPath, 'utf-8');
  } catch {
    return { expired: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { expired: false };
  }
  const oauth = (parsed as { claudeAiOauth?: { expiresAt?: unknown } })?.claudeAiOauth;
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { expired: false };
  }
  return { expired: expiresAt < nowMs, expiresAt };
}

/** Per-agent token rollup over the local-day boundary. Undefined when unavailable. */
interface TokenRollup {
  todayTurns?: number;
  todayCost?: number;
  /** Max token_usage created_at for this agent, normalized to ms. */
  lastSeenMs?: number;
  /**
   * Set when the table EXISTS but the data query failed (e.g. SQLITE_BUSY / I/O).
   * Distinguished from a simply-absent table so the caller can surface an explicit
   * read-fault signal (with the root error) instead of silently reporting
   * empty-but-healthy telemetry. (round-3 MEDIUM/LOW fixes.)
   */
  readError?: string;
}

// SQL fragment normalizing a column to ms inline: seconds rows (< 1e12) * 1000.
// Pushing this into SQL lets us aggregate without materializing every row
// (round-3 MEDIUM: bounded memory/CPU on large tables).
const NORM_MS = (col: string) =>
  `(CASE WHEN ${col} >= ${MS_THRESHOLD} THEN ${col} ELSE ${col} * 1000 END)`;

function tokenRollup(db: ReadonlyDb, agentId: string, startOfLocalDayMs: number): TokenRollup {
  // tableExists/columnExists themselves swallow errors and return false. To tell
  // "absent" from "present but unreadable" we only treat MISSING as empty-normal;
  // a throw from the actual data query below is a read fault, surfaced via readError.
  if (!tableExists(db, 'token_usage')) return {};
  if (!columnExists(db, 'token_usage', 'agent_id')) return {};

  const hasCost = columnExists(db, 'token_usage', 'cost_usd');
  const hasCreatedAt = columnExists(db, 'token_usage', 'created_at');
  if (!hasCreatedAt) {
    // Without created_at we cannot apply the day boundary; count is meaningless.
    return {};
  }

  // Aggregate in SQL: today's turns/cost (normalized-ms boundary) and the
  // all-time max normalized created_at. No per-row materialization.
  const costExpr = hasCost
    ? 'COALESCE(SUM(CASE WHEN norm >= @day THEN cost_usd ELSE 0 END), 0)'
    : 'NULL';
  const sql = `
    SELECT
      SUM(CASE WHEN norm >= @day THEN 1 ELSE 0 END) AS turns,
      ${costExpr} AS cost,
      MAX(norm) AS lastSeen
    FROM (
      SELECT ${NORM_MS('created_at')} AS norm${hasCost ? ', cost_usd' : ''}
      FROM token_usage WHERE agent_id = @agent
    )`;

  let row: {
    turns: number | null;
    cost: number | null;
    lastSeen: number | null;
  };
  try {
    row = db.prepare(sql).get({ agent: agentId, day: startOfLocalDayMs }) as {
      turns: number | null;
      cost: number | null;
      lastSeen: number | null;
    };
  } catch (err) {
    // Table is present but the read failed: a transient fault, not "no data".
    return { readError: err instanceof Error ? err.message : String(err) };
  }

  return {
    todayTurns: row.turns ?? 0,
    todayCost: hasCost ? (row.cost ?? 0) : undefined,
    lastSeenMs: typeof row.lastSeen === 'number' ? row.lastSeen : undefined,
  };
}

/** Per-agent recent activity events from hive_mind. Empty when unavailable. */
interface HiveResult {
  events: ActivityEvent[];
  /** Max hive_mind created_at for this agent, normalized to ms. */
  lastSeenMs?: number;
  /** Set when the table exists but the read failed (round-3 MEDIUM/LOW fixes). */
  readError?: string;
}

function hiveActivity(db: ReadonlyDb, agentId: string, limit: number): HiveResult {
  if (!tableExists(db, 'hive_mind')) return { events: [] };
  if (!columnExists(db, 'hive_mind', 'agent_id')) return { events: [] };
  if (!columnExists(db, 'hive_mind', 'created_at')) return { events: [] };

  const hasAction = columnExists(db, 'hive_mind', 'action');
  const hasSummary = columnExists(db, 'hive_mind', 'summary');
  const hasArtifacts = columnExists(db, 'hive_mind', 'artifacts');

  // IMPORTANT: hive_mind.created_at mixes unix-seconds and unix-ms rows (verified
  // against the live DB). Ordering by the RAW column would let a stale ms-row
  // (large raw int) outrank a genuinely-newer seconds-row, dropping recent
  // activity. We ORDER BY the NORMALIZED-ms expression and LIMIT in SQL, so the
  // read is bounded (round-3 MEDIUM) AND correct (newest-in-real-time wins).
  let rows: Array<{
    norm: number;
    action: string | null;
    summary: string | null;
    artifacts: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT ${NORM_MS('created_at')} AS norm,
                ${hasAction ? 'action' : 'NULL AS action'},
                ${hasSummary ? 'summary' : 'NULL AS summary'},
                ${hasArtifacts ? 'artifacts' : 'NULL AS artifacts'}
           FROM hive_mind WHERE agent_id = @agent
           ORDER BY norm DESC LIMIT @limit`,
      )
      .all({ agent: agentId, limit }) as Array<{
      norm: number;
      action: string | null;
      summary: string | null;
      artifacts: string | null;
    }>;
  } catch (err) {
    // Table present but read failed: a transient fault, not "no activity".
    return {
      events: [],
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  // lastSeen is the true MAX normalized created_at, which may be beyond the event
  // LIMIT, so compute it as a bounded aggregate rather than from the capped rows.
  let lastSeenMs: number | undefined;
  try {
    const agg = db
      .prepare(`SELECT MAX(${NORM_MS('created_at')}) AS m FROM hive_mind WHERE agent_id = @agent`)
      .get({ agent: agentId }) as { m: number | null };
    lastSeenMs = typeof agg.m === 'number' ? agg.m : undefined;
  } catch (err) {
    return {
      events: [],
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  const events: ActivityEvent[] = [];
  for (const r of rows) {
    if (typeof r.norm !== 'number') continue;
    events.push({
      source: 'ccos',
      agentId,
      action: r.action ?? undefined,
      category: r.action ? categorizeAction(r.action) : undefined,
      summary: r.summary ?? undefined,
      artifacts: r.artifacts ?? undefined,
      createdAt: r.norm,
    });
  }

  return { events, lastSeenMs };
}

/** Local-day start (00:00 in the host timezone) as unix ms, derived from now. */
function startOfLocalDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Build a read-only adapter over the CCOS local store.
 *
 * The returned adapter's `pull()`:
 *   - opens dbPath with { readonly: true, fileMustExist: true } (only throw site),
 *   - emits one AgentRecord per configured agent,
 *   - classifies status from PID liveness + OAuth expiry,
 *   - rolls up today's turns/cost from token_usage (by agent_id, local-day),
 *   - reads recent hive_mind activity, normalizing per-row seconds/ms to ms,
 *   - closes the DB handle in a finally block.
 */
export function createCcosNativeAdapter(config: CcosNativeConfig = {}): FleetAdapter {
  const dbPath = config.dbPath ?? defaultDbPath();
  const storeDir = config.storeDir ?? dirname(dbPath);
  const credentialsPath = config.credentialsPath ?? defaultCredentialsPath();
  const agentIds = config.agentIds ?? DEFAULT_AGENT_IDS;
  const eventLimit = config.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
  const now = config.now ?? Date.now;
  const isAlive = config.isProcessAlive ?? defaultIsProcessAlive;

  async function pull(): Promise<FleetPull> {
    const nowMs = now();
    const dayStart = startOfLocalDayMs(nowMs);

    // The ONLY permitted throw: an un-openable dbPath. Fail toward the human.
    // Always read-only + fileMustExist; the corpus is never opened because the
    // ONLY path passed here is the configured dbPath. There is no injectable
    // opener on the public API, so a caller cannot redirect or escalate this.
    const db = openReadonly(dbPath);

    try {
      const agents: AgentRecord[] = [];
      const statuses: AgentStatus[] = [];
      const events: ActivityEvent[] = [];

      for (const id of agentIds) {
        agents.push({
          source: 'ccos',
          agentId: id,
          name: displayName(id),
          ownerHuman: 'the owner',
          // model intentionally left undefined in v1 (not cheaply readable read-only).
        });

        const roll = tokenRollup(db, id, dayStart);
        const hive = hiveActivity(db, id, eventLimit);
        for (const e of hive.events) events.push(e);

        // lastSeen = max created_at across token_usage and hive_mind (ms), if any.
        const lastSeen = maxDefined(roll.lastSeenMs, hive.lastSeenMs);

        const probe = probePid(storeDir, id, isAlive);
        let status: Status;
        let detail: string | undefined;

        // A DB read fault (table present but query threw, e.g. SQLITE_BUSY / I/O)
        // must NOT be reported as a healthy agent with empty telemetry. Surface it
        // as a stale signal carrying the ROOT error so on-call can triage
        // contention vs corruption. (round-3 MEDIUM + LOW fixes.)
        const readErr = roll.readError ?? hive.readError;
        // A throwing liveness probe is a fault to surface, not silence. (round-3 LOW fix.)
        const probeNote = probe.kind === 'read' && probe.probeError ? `${probe.probeError}; ` : '';

        if (readErr !== undefined) {
          status = 'stale';
          detail = `${probeNote}telemetry read failed (${readErr}); status not trustworthy this pull`;
        } else if (probe.kind === 'absent') {
          status = 'unknown';
          detail = 'no PID file';
        } else if (probe.kind === 'read' && probe.alive) {
          // Boundary: activity exactly idleMs old counts as idle (>=), not up.
          const idle = lastSeen !== undefined && nowMs - lastSeen >= idleMs;
          status = idle ? 'idle' : 'up';
          detail = `${probeNote}${idle ? 'alive, no activity in idle window' : 'alive'}`;
        } else {
          // Not alive: either a read PID that is dead, or an unreadable PID file.
          // Classify oauth-expired vs down; if the PID file was unreadable, surface
          // that in the detail so the uncertainty is not masked as a clean state.
          const oauth = probeOauth(credentialsPath, nowMs);
          const base = probe.kind === 'error' ? `${probe.detail}; ` : probeNote;
          if (oauth.expired) {
            status = 'oauth-expired';
            detail = `${base}process down; OAuth token lapsed`;
          } else {
            status = 'down';
            detail = `${base}process not running`;
          }
        }

        statuses.push({
          source: 'ccos',
          agentId: id,
          status,
          detail,
          todayTurns: roll.todayTurns,
          todayCost: roll.todayCost,
          lastSeen,
        });
      }

      return { agents, statuses, events };
    } finally {
      // Never leave a handle open on the live, WAL-mode DB.
      db.close();
    }
  }

  return { source: 'ccos', pull };
}

/** Max of two optional numbers; undefined only when both are undefined. */
function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

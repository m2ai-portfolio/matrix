// Matrix Fleet Visibility - board read API + page (docs/FLEET-VISIBILITY.md sec6/9).
//
// A Hono app serving the board page (GET /) plus a read-only JSON API
// (GET /api/fleet, GET /api/activity). Every route is gated by the ?token=
// shared secret (auth.ts, fail-closed).
//
// SAFETY (FIX B / HARD #1 / HARD #2):
//   - The ops DB path comes ONLY from env MATRIX_OPS_DB (default = the real
//     store/matrix-ops.db path). There is NO caller-injectable opener and NO
//     test-only opener seam: the rejected attack surface is gone. Tests point
//     MATRIX_OPS_DB at a seeded temp db.
//   - The DB is opened READ-ONLY via better-sqlite3 { readonly: true,
//     fileMustExist: true }. No schema is applied and nothing is ever written:
//     the board can never mutate any DB it is pointed at, and a misrouted path
//     can never be created/migrated. An absent DB fails gracefully (503).
//   - createBoardApp takes no DB / opener argument at all.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { resolve, dirname, join, basename } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getActivity, getFleet } from '../ops/queries.js';
import type { Source } from './adapter.js';
import { isAuthorizedAll, readDashboardToken } from './auth.js';
import { renderBoardHtml, renderBoardError, ALL_SOURCES } from './html.js';

/** Default page size for the activity feed. */
export const DEFAULT_ACTIVITY_LIMIT = 50;
/** Hard ceiling so a client can never request an unbounded read. */
export const MAX_ACTIVITY_LIMIT = 500;

/**
 * Option B allowlist (LOCKED): the board may ONLY ever open a DB file whose
 * basename is exactly this. The corpus (store/matrix.db) and the live
 * claudeclaw.db can never be reached, even read-only, because their basenames
 * differ. Exact equality, not substring, so a path like
 * "/x/claudeclaw.db.matrix-ops.db.bak" or "/x/notmatrix-ops.db" is refused.
 */
export const OPS_DB_BASENAME = 'matrix-ops.db';

/** Resolve the repo root from this module location (src/fleet -> repo root). */
function repoRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/**
 * The TRUSTED ROOT directory the ops DB must live in. Defaults to the repo
 * store/ dir. Overridable via env MATRIX_OPS_TRUSTED_ROOT for tests / alternate
 * deployments. The resolved ops DB path's directory must equal this (after
 * realpath), so a matrix-ops.db placed anywhere ELSE (or a symlink/hard link
 * pointing OUT of the trusted root) is refused regardless of basename or inode.
 * This is the principled superset of an inode denylist: instead of enumerating
 * every forbidden file, we permit exactly one trusted directory.
 */
function trustedRootDir(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const override = env.MATRIX_OPS_TRUSTED_ROOT;
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return join(repoRootDir(), 'store');
}

/** Realpath a dir if it exists, else return the resolved literal (for compare). */
function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Enforce the Option B basename allowlist PLUS a trusted-root anchor. Throws
 * unless ALL hold; returns the realpath-resolved target so the caller opens the
 * EXACT checked file (closes the check/open TOCTOU gap).
 *
 * Layered hardening:
 *   - LITERAL basename must be matrix-ops.db (refuses the obvious misroute).
 *   - TRUSTED ROOT: the file's PARENT directory (realpath-resolved) must be the
 *     trusted root. A matrix-ops.db outside the trusted store dir is refused,
 *     which subsumes "any claudeclaw.db hard-linked elsewhere" and "a path that
 *     does not exist yet in an untrusted dir" (fail closed).
 *   - SYMLINK: when the path exists, the REAL (link-resolved) basename must also
 *     be matrix-ops.db AND resolve inside the trusted root, so a symlink
 *     matrix-ops.db -> /elsewhere/claudeclaw.db is refused (target dir != root).
 *   - HARD LINK: a hard link shares an inode but the trusted-root anchor still
 *     applies to its own directory; a hard link to the corpus that also sits in
 *     the trusted root is additionally caught by the device+inode collision
 *     check against the discoverable corpus files.
 */
function assertAndResolveOpsPath(
  path: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  if (basename(path) !== OPS_DB_BASENAME) {
    throw new Error(
      `refused ops DB path: basename must be '${OPS_DB_BASENAME}', got '${basename(path)}'`,
    );
  }

  const root = realDir(trustedRootDir(env));

  let real: string;
  let exists = true;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
    exists = false;
  }

  if (basename(real) !== OPS_DB_BASENAME) {
    throw new Error(
      `refused ops DB path: link target basename must be '${OPS_DB_BASENAME}', got '${basename(real)}'`,
    );
  }

  // TRUSTED ROOT anchor: the (real) parent directory must be the trusted root.
  // For an existing path, dirname(real) is the link-resolved directory; for a
  // not-yet-existing path, we realpath its PARENT (which must exist) so a
  // symlinked parent cannot smuggle the file out of the trusted root, and a
  // non-existent path in an untrusted dir fails closed.
  const parentReal = exists ? realDir(dirname(real)) : realDir(dirname(path));
  if (parentReal !== root) {
    throw new Error(
      `refused ops DB path: must live in the trusted root '${root}', got parent '${parentReal}'`,
    );
  }

  // Inode-collision backstop: even inside the trusted root, refuse a hard link
  // whose inode IS a discoverable forbidden corpus file.
  if (exists) {
    const targetId = fileIdentity(real);
    if (targetId !== undefined) {
      const r = repoRootDir();
      const candidates = [
        join(r, 'store', 'matrix.db'),
        join(r, '..', 'claudeclaw-os', 'store', 'claudeclaw.db'),
      ];
      for (const candidate of candidates) {
        const candId = fileIdentity(candidate);
        if (candId !== undefined && candId === targetId) {
          throw new Error(
            `refused ops DB path: '${real}' is the same file as a forbidden corpus DB (hard-link bypass)`,
          );
        }
      }
    }
  }

  return real;
}

/** device:inode identity of a path, or undefined if it does not exist. */
function fileIdentity(path: string): string | undefined {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}`;
  } catch {
    return undefined;
  }
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set<Source>(['ccos', 'cmd', 'hermes', 'vendor']);

/**
 * Resolve the ops DB path. Operator config via env MATRIX_OPS_DB only; default
 * is the real store/matrix-ops.db (resolved relative to this module, which lives
 * at src/fleet/board-api.ts -> two levels under the repo root).
 *
 * Option B allowlist (LOCKED): the resolved path MUST have basename
 * 'matrix-ops.db' or this THROWS. Applies to BOTH the env-supplied path and the
 * default, so a misrouted MATRIX_OPS_DB (e.g. a claudeclaw.db path) is REFUSED,
 * never opened.
 */
export function resolveOpsDbPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.MATRIX_OPS_DB;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return assertAndResolveOpsPath(fromEnv.trim(), env);
  }
  const path = join(repoRootDir(), 'store', OPS_DB_BASENAME);
  return assertAndResolveOpsPath(path, env);
}

/**
 * Open the ops DB strictly READ-ONLY. No schema, no writes. fileMustExist makes
 * an absent path throw rather than create a new db. The only configuration is
 * the resolved env path; there is no injectable opener.
 *
 * TOCTOU: resolveOpsDbPath returns the REALPATH-resolved target it just checked,
 * and we open exactly that resolved path, so the file checked is the file opened
 * (a swap of the original path after the check cannot redirect the open).
 */
function openOpsReadonly(): Database.Database {
  const path = resolveOpsDbPath();
  return new Database(path, { readonly: true, fileMustExist: true });
}

/**
 * Log an ops-DB open/read failure with the fields on-call needs to triage:
 * route, the configured (UNRESOLVED) ops path, the trusted root, and the error
 * message. This distinguishes ENOENT vs trusted-root refusal vs sqlite fault.
 * It NEVER logs the dashboard token (the token is not in scope here and is never
 * read into this function). Uses console.error so it lands on the error stream.
 */
function logOpsFailure(route: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // The raw configured path (not resolved) is safe to log and is the operator's
  // actual misconfig; the trusted root tells them the allowed location.
  const configuredPath = process.env.MATRIX_OPS_DB ?? '(default store/)';
  const trustedRoot = process.env.MATRIX_OPS_TRUSTED_ROOT ?? '(default store/)';
  console.error(
    `[fleet-board] ops store unavailable on ${route}: ${message} ` +
      `(configured MATRIX_OPS_DB=${configuredPath}, trustedRoot=${trustedRoot})`,
  );
}

/**
 * Clamp a user-supplied limit to a safe, positive, bounded integer. Non-integer,
 * NaN, empty, negative, or zero inputs fall back to the default. Anything above
 * the ceiling is clamped down. Never returns < 1 or > MAX.
 */
export function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACTIVITY_LIMIT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_ACTIVITY_LIMIT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(n, MAX_ACTIVITY_LIMIT);
}

/** Validate a source query value against the known set. Empty/undefined = no filter. */
export function parseSource(raw: string | undefined): {
  ok: boolean;
  source?: Source;
} {
  if (raw === undefined || raw.trim().length === 0) return { ok: true };
  const v = raw.trim();
  if (KNOWN_SOURCES.has(v)) return { ok: true, source: v as Source };
  return { ok: false };
}

/**
 * Build the board Hono app. Takes NO arguments: the ops DB path is env-only and
 * the open is always read-only. A fresh read-only handle is opened per request
 * and closed in a finally block, so the board holds no long-lived DB handle.
 */
export function createBoardApp(): Hono {
  const app = new Hono();

  // Shared auth guard: reject unless EVERY supplied ?token= matches the
  // configured token (duplicate-param bypass-proof) and a token is configured.
  const authorize = (suppliedTokens: string[]): boolean => {
    const configured = readDashboardToken(process.env);
    return isAuthorizedAll(configured, suppliedTokens);
  };

  app.get('/api/fleet', (c) => {
    if (!authorize(c.req.queries('token') ?? [])) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = parseSource(c.req.query('source'));
    if (!parsed.ok) return c.json({ error: 'unknown source' }, 400);

    let db: Database.Database | undefined;
    try {
      db = openOpsReadonly();
      const rows = getFleet(db, parsed.source);
      return c.json(rows);
    } catch (err) {
      logOpsFailure('GET /api/fleet', err);
      return c.json({ error: 'ops store unavailable' }, 503);
    } finally {
      db?.close();
    }
  });

  app.get('/api/activity', (c) => {
    if (!authorize(c.req.queries('token') ?? [])) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = parseSource(c.req.query('source'));
    if (!parsed.ok) return c.json({ error: 'unknown source' }, 400);
    const limit = clampLimit(c.req.query('limit'));
    // Trim agentKey; a whitespace-only or empty value is treated as ABSENT
    // (no filter), the same as undefined.
    const agentKeyRaw = c.req.query('agentKey');
    const agentKey =
      typeof agentKeyRaw === 'string' && agentKeyRaw.trim().length > 0
        ? agentKeyRaw.trim()
        : undefined;

    let db: Database.Database | undefined;
    try {
      db = openOpsReadonly();
      const events = getActivity(db, {
        limit,
        source: parsed.source,
        agentKey,
      });
      return c.json(events);
    } catch (err) {
      logOpsFailure('GET /api/activity', err);
      return c.json({ error: 'ops store unavailable' }, 503);
    } finally {
      db?.close();
    }
  });

  app.get('/', (c) => {
    const suppliedTokens = c.req.queries('token') ?? [];
    if (!authorize(suppliedTokens)) {
      return c.text('unauthorized', 401);
    }
    // The token is NOT embedded in the served page (no server-side token sink,
    // so a malicious token can never break out of the HTML). The inline JS reads
    // ?token= from its own URL (location.search) at runtime.

    let db: Database.Database | undefined;
    try {
      db = openOpsReadonly();
      // The open SUCCEEDED: the DB is reachable. A genuinely empty DB renders
      // the normal (empty-grid) board. We never mask an outage as healthy here
      // because an unreachable / refused DB throws and is handled below.
      const fleet = getFleet(db);
      const activity = getActivity(db, { limit: DEFAULT_ACTIVITY_LIMIT });
      return c.html(renderBoardHtml(fleet, activity, ALL_SOURCES));
    } catch (err) {
      // Ops DB missing, unreadable, or refused by the allowlist. Do NOT serve a
      // misleading 'healthy' board: render an explicit error state with 503.
      logOpsFailure('GET /', err);
      return c.html(renderBoardError(), 503);
    } finally {
      db?.close();
    }
  });

  return app;
}

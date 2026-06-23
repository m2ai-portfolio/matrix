// Matrix Fleet Visibility — operational store open + default path.
//
// Mirrors src/db/open.ts but targets a SEPARATE store file, store/matrix-ops.db,
// so the board never opens the sensitive corpus DB (docs/FLEET-VISIBILITY.md §1).

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { applyOpsSchema } from './schema.js';

/**
 * Resolved default ops DB path: <repoRoot>/store/matrix-ops.db.
 * This module lives at src/ops/open.ts (2 levels under root).
 */
export function defaultOpsDbPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  return join(repoRoot, 'store', 'matrix-ops.db');
}

/** True for paths that must NOT trigger store/ directory creation. */
function isEphemeralPath(path: string): boolean {
  return path === ':memory:' || path === '' || path.startsWith(':');
}

/**
 * Open (or create) the operational SQLite DB and apply the ops schema idempotently.
 *
 * @param path Optional DB path. Default = <repo>/store/matrix-ops.db with the
 *             store/ dir ensured. Pass ':memory:' or a temp path in tests so the
 *             real store is never written; for those the store/ dir is NOT created.
 */
export function openOpsDb(path?: string): Database.Database {
  const usingDefault = path === undefined;
  const target = usingDefault ? defaultOpsDbPath() : path;

  if (usingDefault && !isEphemeralPath(target)) {
    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(target);
  applyOpsSchema(db);
  return db;
}

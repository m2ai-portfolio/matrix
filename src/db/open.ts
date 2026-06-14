// Matrix Phase 0 — DB open + default store path.
// Builder implementation. Spec claims: C-25, C-02, C-10.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { applySchema } from './schema.js';

/**
 * The resolved default DB path: <repoRoot>/store/matrix.db (C-02, C-25).
 *
 * This module lives at src/db/open.ts, i.e. 2 levels under the repo root, so
 * repoRoot = resolve(dirname(thisFile), '..', '..').
 */
export function defaultDbPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  return join(repoRoot, 'store', 'matrix.db');
}

/** True for paths that must NOT trigger store/ directory creation. */
function isEphemeralPath(path: string): boolean {
  return path === ':memory:' || path === '' || path.startsWith(':');
}

/**
 * Open (or create) the warehouse SQLite DB and apply the schema idempotently.
 *
 * @param path  Optional DB path. Default = <repo>/store/matrix.db resolved
 *              relative to project root, with the store/ dir ensured to exist (C-25, C-02).
 *              Pass ':memory:' or a temp path in tests so the real store is never written;
 *              for those the store/ dir is NOT created.
 */
export function openDb(path?: string): Database.Database {
  const usingDefault = path === undefined;
  const target = usingDefault ? defaultDbPath() : path;

  // Only ensure the store/ dir for the default warehouse path. Temp/:memory:
  // paths must not create a store/ dir (C-02 isolation).
  if (usingDefault && !isEphemeralPath(target)) {
    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(target);
  applySchema(db);
  return db;
}

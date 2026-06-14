// Test helpers: temp dirs / temp DBs so NO test ever writes the real store/matrix.db
// or reads the real ~/.claude/projects transcripts (C-22).

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a unique temp dir under the OS tmp dir. Caller cleans up via cleanup(). */
export function makeTmpDir(prefix = 'matrix-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write content to a file inside dir, return its path. */
export function writeFixtureFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Recursively remove a temp dir. */
export function cleanupTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

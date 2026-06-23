// Tests for the Option B basename allowlist (+ trusted-root anchor + symlink /
// hard-link / TOCTOU hardening) in src/fleet/board-api.ts.
//
// LOCKED decision (Option B): resolveOpsDbPath() MUST enforce
//   basename(resolvedPath) === 'matrix-ops.db'
// or THROW, for BOTH the env-supplied path and the default. On top of that the
// resolved file must live in a TRUSTED ROOT directory (default: repo store/;
// overridable via MATRIX_OPS_TRUSTED_ROOT for tests). Together these make "aim
// the board at claudeclaw.db / store/matrix.db" impossible, even read-only.
//
// Covers C-61 (throw unless basename matches; default + env), C-62 (claudeclaw
// path refused), C-63 (corpus matrix.db refused), C-64 (default + valid temp
// path accepted), C-69 (exact-basename, not substring), C-70 (dressed-up
// claudeclaw path refused), C-71 (symlink/realpath), C-74 (hard-link inode),
// C-75 (TOCTOU: returns realpath target), and the trusted-root anchor.

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOpsDbPath, OPS_DB_BASENAME } from '../src/fleet/board-api.js';

// The repo root, computed from this test's own location (tests/ -> repo root).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Option B basename allowlist + trusted root (C-61..C-75)', () => {
  it('exports the locked basename constant', () => {
    expect(OPS_DB_BASENAME).toBe('matrix-ops.db');
  });

  it('accepts the default path (no env) and it ends in matrix-ops.db (C-61, C-64)', () => {
    // Default trusted root = repo store/; the default ops db lives there.
    expect(() => resolveOpsDbPath({})).not.toThrow();
    expect(resolveOpsDbPath({})).toMatch(/(^|\/)matrix-ops\.db$/);
  });

  it('accepts an env path whose basename is matrix-ops.db inside its trusted root (C-61, C-64)', () => {
    expect(
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/x/y/matrix-ops.db',
        MATRIX_OPS_TRUSTED_ROOT: '/x/y',
      }),
    ).toBe('/x/y/matrix-ops.db');
  });

  it("accepts a real temp '.../matrix-ops.db' path in its trusted root (C-64)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      const good = join(dir, 'matrix-ops.db');
      writeFileSync(good, '');
      const env = { MATRIX_OPS_DB: good, MATRIX_OPS_TRUSTED_ROOT: dir };
      expect(() => resolveOpsDbPath(env)).not.toThrow();
      expect(resolveOpsDbPath(env)).toBe(realpathSync(good));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES a matrix-ops.db OUTSIDE the trusted root (trusted-root anchor)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allowlist-untrusted-'));
    try {
      const good = join(dir, 'matrix-ops.db');
      writeFileSync(good, '');
      // Trusted root is some OTHER dir, so this is refused even though the
      // basename is correct and the file exists.
      expect(() =>
        resolveOpsDbPath({
          MATRIX_OPS_DB: good,
          MATRIX_OPS_TRUSTED_ROOT: '/some/other/trusted/root',
        }),
      ).toThrow(/trusted root/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES a claudeclaw.db path (C-62)', () => {
    expect(() =>
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/opt/claudeclaw-os/store/claudeclaw.db',
      }),
    ).toThrow();
  });

  it('REFUSES a dressed-up live claudeclaw path (C-70)', () => {
    expect(() =>
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/opt/claudeclaw-home/claudeclaw.db',
      }),
    ).toThrow();
  });

  it('REFUSES the corpus store/matrix.db (C-63)', () => {
    expect(() => resolveOpsDbPath({ MATRIX_OPS_DB: '/x/store/matrix.db' })).toThrow();
  });

  it('uses EXACT basename match, not substring (C-69)', () => {
    // basename merely CONTAINS the allowed name as a fragment -> refused.
    expect(() => resolveOpsDbPath({ MATRIX_OPS_DB: '/x/notmatrix-ops.db' })).toThrow();
    expect(() =>
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/x/claudeclaw.db.matrix-ops.db.bak',
      }),
    ).toThrow();
    // A directory NAMED matrix-ops.db with a file under it -> basename is the
    // file, not the dir, so it is refused.
    expect(() => resolveOpsDbPath({ MATRIX_OPS_DB: '/x/matrix-ops.db/inner.db' })).toThrow();
  });

  it('REFUSES a symlink named matrix-ops.db whose target is claudeclaw.db (C-71)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allowlist-symlink-'));
    try {
      // A real file masquerading as the corpus, plus a symlink that LOOKS like
      // an ops db but resolves to it. Trusted root = dir so the test reaches the
      // link-basename check (it must throw on the resolved basename).
      const target = join(dir, 'claudeclaw.db');
      writeFileSync(target, '');
      const link = join(dir, 'matrix-ops.db');
      symlinkSync(target, link);
      expect(() =>
        resolveOpsDbPath({
          MATRIX_OPS_DB: link,
          MATRIX_OPS_TRUSTED_ROOT: dir,
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ACCEPTS a symlink named matrix-ops.db that resolves to a real matrix-ops.db in the trusted root, returning the resolved target (C-71 positive, C-75)', () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'allowlist-symlink-ok-'));
    const linkDir = mkdtempSync(join(tmpdir(), 'allowlist-link-'));
    try {
      const target = join(targetDir, 'matrix-ops.db');
      writeFileSync(target, '');
      const link = join(linkDir, 'matrix-ops.db');
      symlinkSync(target, link);
      // The REAL file lives in targetDir, so targetDir is the trusted root.
      const env = { MATRIX_OPS_DB: link, MATRIX_OPS_TRUSTED_ROOT: targetDir };
      expect(() => resolveOpsDbPath(env)).not.toThrow();
      // C-75 (TOCTOU): returns the REALPATH-resolved target (what the open will
      // use), not the raw link path.
      expect(resolveOpsDbPath(env)).toBe(realpathSync(target));
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('REFUSES a HARD LINK named matrix-ops.db whose inode is the repo corpus store/matrix.db (C-74)', () => {
    // Create the repo's own store/matrix.db (gitignored), hard-link a
    // matrix-ops.db to its exact inode INSIDE a trusted subdir (so the
    // trusted-root anchor passes and the test actually exercises the device+inode
    // collision backstop). basename + realpath both PASS; only the inode check
    // catches it. Everything is cleaned up afterward.
    const storeDir = join(REPO_ROOT, 'store');
    const corpus = join(storeDir, 'matrix.db');
    const sub = join(storeDir, 'hl-sub');
    const hard = join(sub, 'matrix-ops.db');
    let createdCorpus = false;
    try {
      mkdirSync(storeDir, { recursive: true });
      if (!existsSync(corpus)) {
        writeFileSync(corpus, 'corpus-fixture');
        createdCorpus = true;
      }
      mkdirSync(sub, { recursive: true });
      linkSync(corpus, hard);
      expect(() =>
        resolveOpsDbPath({
          MATRIX_OPS_DB: hard,
          MATRIX_OPS_TRUSTED_ROOT: sub,
        }),
      ).toThrow(/hard-link|corpus|forbidden/i);
    } finally {
      if (existsSync(sub)) rmSync(sub, { recursive: true, force: true });
      if (createdCorpus && existsSync(corpus)) rmSync(corpus, { force: true });
    }
  });

  it('FAILS CLOSED on a non-existent path in an untrusted dir (TOCTOU on ENOENT, C-75)', () => {
    // A matrix-ops.db that does not exist yet, in a dir that is NOT the trusted
    // root, is refused (so an attacker cannot create a symlink there between
    // check and open).
    expect(() =>
      resolveOpsDbPath({
        MATRIX_OPS_DB: '/tmp/definitely-not-trusted/matrix-ops.db',
        MATRIX_OPS_TRUSTED_ROOT: '/some/other/root',
      }),
    ).toThrow(/trusted root/i);
  });
});

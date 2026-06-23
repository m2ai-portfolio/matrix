// Tests for src/fleet/auth.ts - token resolution, constant-time compare,
// fail-closed authorization, and duplicate-param-proof authorization.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './strip-comments.js';
import {
  isAuthorized,
  isAuthorizedAll,
  readDashboardToken,
  safeTokenEqual,
} from '../src/fleet/auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_SRC = join(HERE, '..', 'src', 'fleet', 'auth.ts');

describe('readDashboardToken (C-14)', () => {
  it('prefers FLEET_DASHBOARD_TOKEN over DASHBOARD_TOKEN', () => {
    expect(
      readDashboardToken({
        FLEET_DASHBOARD_TOKEN: 'fleet',
        DASHBOARD_TOKEN: 'fallback',
      }),
    ).toBe('fleet');
  });

  it('falls back to DASHBOARD_TOKEN', () => {
    expect(readDashboardToken({ DASHBOARD_TOKEN: 'fallback' })).toBe('fallback');
  });

  it('returns null when neither is set (fail closed)', () => {
    expect(readDashboardToken({})).toBeNull();
  });

  it('returns null for an empty / whitespace token (fail closed)', () => {
    expect(readDashboardToken({ DASHBOARD_TOKEN: '   ' })).toBeNull();
    expect(readDashboardToken({ FLEET_DASHBOARD_TOKEN: '' })).toBeNull();
  });
});

describe('safeTokenEqual (C-15, C-52)', () => {
  // C-15 STRUCTURAL: the compare uses a constant-time primitive (timingSafeEqual)
  // over fixed-width sha256 digests. We assert the source uses these primitives
  // rather than measuring wall-clock timing (which is flaky and not a reliable
  // signal of constant-time behavior under a JIT). The behavioral tests below
  // cover correctness; together they pin "constant-time primitive, used right".
  it('uses crypto.timingSafeEqual over sha256 digests (C-15 structural)', () => {
    const code = stripComments(readFileSync(AUTH_SRC, 'utf8'));
    expect(code).toContain('timingSafeEqual');
    expect(code).toContain('createHash');
    expect(code).toMatch(/sha256/i);
    // The compare must run timingSafeEqual on the digests, not on raw inputs.
    expect(code).toMatch(/timingSafeEqual\s*\(/);
  });

  // C-15 BEHAVIORAL: correct accept/reject, including unequal-length inputs that
  // would make a naive timingSafeEqual throw (the digest hashing makes both
  // operands fixed 32-byte width).
  it('returns true for identical strings', () => {
    expect(safeTokenEqual('s3cret', 's3cret')).toBe(true);
  });

  it('returns false for different equal-length strings', () => {
    expect(safeTokenEqual('aaaaaa', 'bbbbbb')).toBe(false);
  });

  it('returns false for different-length strings without throwing (C-52)', () => {
    expect(() => safeTokenEqual('short', 'muchlongertoken')).not.toThrow();
    expect(safeTokenEqual('short', 'muchlongertoken')).toBe(false);
  });

  it('returns false when one side is empty (no accidental match)', () => {
    expect(safeTokenEqual('', 'nonempty')).toBe(false);
    expect(safeTokenEqual('nonempty', '')).toBe(false);
  });
});

describe('isAuthorized (C-16, C-17)', () => {
  it('fails closed when no token is configured', () => {
    expect(isAuthorized(null, 'anything')).toBe(false);
  });

  it('rejects an absent or empty supplied token', () => {
    expect(isAuthorized('good', undefined)).toBe(false);
    expect(isAuthorized('good', '')).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(isAuthorized('good', 'wrong')).toBe(false);
  });

  it('accepts the correct token', () => {
    expect(isAuthorized('good', 'good')).toBe(true);
  });
});

describe('isAuthorizedAll - duplicate-param proof (C-27, C-50, C-51)', () => {
  it('fails closed when no token configured', () => {
    expect(isAuthorizedAll(null, ['good'])).toBe(false);
  });

  it('rejects empty supplied list', () => {
    expect(isAuthorizedAll('good', [])).toBe(false);
  });

  it('rejects an empty token value (C-51)', () => {
    expect(isAuthorizedAll('good', [''])).toBe(false);
  });

  it('accepts a single matching value', () => {
    expect(isAuthorizedAll('good', ['good'])).toBe(true);
  });

  it('rejects when ANY duplicate value mismatches, either order (C-27, C-50)', () => {
    expect(isAuthorizedAll('good', ['wrong', 'good'])).toBe(false);
    expect(isAuthorizedAll('good', ['good', 'wrong'])).toBe(false);
  });

  it('accepts only when every duplicate matches', () => {
    expect(isAuthorizedAll('good', ['good', 'good'])).toBe(true);
  });
});

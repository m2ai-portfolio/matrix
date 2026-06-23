// Matrix Fleet Visibility - dashboard token auth (docs/FLEET-VISIBILITY.md sec3 serve+auth).
//
// The board is LAN-exposed (bind 0.0.0.0), so every route is gated by a shared
// ?token= secret. Policy is fail-closed: if no token is configured in the
// environment, NO request authorizes. The token is read from the environment
// (FLEET_DASHBOARD_TOKEN, falling back to DASHBOARD_TOKEN), never hardcoded, and
// never logged.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Resolve the configured dashboard token from an environment-like map.
 * Precedence: FLEET_DASHBOARD_TOKEN, then DASHBOARD_TOKEN. The value is trimmed.
 * Returns null when neither is set or the resolved value is empty after trim, so
 * the caller can fail closed (an empty/absent secret must never authorize).
 */
export function readDashboardToken(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  const raw = env.FLEET_DASHBOARD_TOKEN ?? env.DASHBOARD_TOKEN;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Constant-time string comparison that is also length-independent.
 *
 * Node's timingSafeEqual throws on length-mismatched buffers, and a naive guard
 * (a.length !== b.length) leaks length via an early return. We compare the
 * SHA-256 digests of both inputs: digests are always 32 bytes, so the comparison
 * is fixed-width regardless of input length, and timingSafeEqual then runs in
 * constant time. An empty string still produces a digest, but an empty supplied
 * token is rejected upstream (a null configured token never reaches here).
 */
export function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  // Both digests are 32 bytes; timingSafeEqual is safe and constant-time here.
  return timingSafeEqual(da, db);
}

/**
 * Authorize a single request.
 * @param configured The token resolved from the environment (null = none set).
 * @param supplied   The ?token= value from the request (undefined = absent).
 * @returns true only when a non-null token is configured AND the supplied value
 *          is a non-empty string that matches it. Fails closed otherwise.
 */
export function isAuthorized(configured: string | null, supplied: string | undefined): boolean {
  if (configured === null) return false;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  return safeTokenEqual(configured, supplied);
}

/**
 * Authorize against ALL supplied ?token= values (Hono can carry duplicates).
 * Bypass-proof rule: authorize ONLY when at least one value is supplied AND
 * EVERY supplied value matches the configured token. A single mismatching
 * duplicate (token=wrong&token=right, in any order) rejects. Fails closed when
 * no token is configured or none is supplied.
 */
export function isAuthorizedAll(configured: string | null, supplied: string[]): boolean {
  if (configured === null) return false;
  if (supplied.length === 0) return false;
  return supplied.every((value) => isAuthorized(configured, value));
}

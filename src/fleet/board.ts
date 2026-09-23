// Matrix Fleet Visibility - board serve entrypoint (docs/FLEET-VISIBILITY.md sec6/9).
//
// Binds the board Hono app on 0.0.0.0 (LAN-reachable) and prints the LAN URL.
//
// SAFETY: the user-facing URL is always the LAN host 192.0.2.10 (HARD #3), never
// localhost / 127.0.0.1. The token is NOT echoed into the printed URL (it is a
// secret); the URL is printed with a ?token= placeholder so an operator knows to
// append it.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createBoardApp } from './board-api.js';

/**
 * First private-range (RFC 1918) IPv4 on a non-internal interface, or undefined.
 * Tailscale CGNAT (100.64/10) and public addresses are skipped on purpose.
 */
export function detectLanHost(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return undefined;
}

/**
 * LAN host the board is advertised on (HARD #3 - never localhost/127.0.0.1).
 * MATRIX_LAN_HOST wins; otherwise the detected LAN address; otherwise BIND_HOST.
 */
export const LAN_HOST = process.env.MATRIX_LAN_HOST || detectLanHost() || '0.0.0.0';
/** Bind address - all interfaces, so the LAN host reaches it. */
export const BIND_HOST = '0.0.0.0';
/** Default port if PORT is unset. */
export const DEFAULT_PORT = 8787;

/**
 * Resolve the port from env PORT (default DEFAULT_PORT). 0 = ephemeral (tests).
 * An out-of-range value (PORT > 65535) or a non-numeric value falls back to the
 * default rather than failing startup with an opaque bind error. Valid TCP port
 * range is 0..65535 (0 means OS-assigned ephemeral).
 */
export function resolvePort(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env.PORT;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) {
      return n;
    }
    return DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

export interface StartedBoard {
  /** The actual bound port (resolved after listen, so ephemeral 0 works). */
  port: number;
  /** Close the server. */
  close: () => void;
}

/**
 * Start the board server bound on 0.0.0.0. Returns the resolved port and a close
 * handle. Logs the LAN URL (192.0.2.10) on listen. The token is never printed.
 *
 * Failure posture (C-39 / C-65): a bind failure such as EADDRINUSE REJECTS the
 * returned promise with a clear Error instead of leaving an unhandled 'error'
 * event on the underlying server. Callers therefore get a rejection (the
 * non-zero / error path) rather than a hang or an opaque process crash. The
 * promise settles exactly once (a guard prevents a late error after listen).
 */
export function startBoard(
  opts: { port?: number; log?: (line: string) => void } = {},
): Promise<StartedBoard> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const port = opts.port ?? resolvePort();
  const app = createBoardApp();

  return new Promise<StartedBoard>((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, hostname: BIND_HOST, port }, (info: AddressInfo) => {
      if (settled) return;
      settled = true;
      const boundPort = info.port;
      log(`Matrix Fleet Board listening on ${BIND_HOST}:${boundPort}`);
      log(`Open: http://${LAN_HOST}:${boundPort}/?token=YOUR_TOKEN`);
      resolvePromise({
        port: boundPort,
        close: () => server.close(),
      });
    });

    // Surface a bind failure (EADDRINUSE etc.) as a promise rejection, not an
    // unhandled 'error' event. The node-server exposes the underlying
    // http.Server, which emits 'error' on a failed listen.
    server.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // best-effort; the listen never succeeded
      }
      rejectPromise(
        err instanceof Error
          ? err
          : new Error(`Matrix Fleet Board failed to start: ${String(err)}`),
      );
    });
  });
}

// Auto-start only when run directly (node dist/fleet/board.js), never on import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void startBoard().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Matrix Fleet Board failed to start: ${msg}`);
    process.exitCode = 1;
  });
}

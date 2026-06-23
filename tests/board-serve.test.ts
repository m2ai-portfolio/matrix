// Tests for src/fleet/board.ts - serve entrypoint. Starts on an ephemeral port,
// verifies the 0.0.0.0 bind, the LAN URL (192.0.2.10, never localhost), and a
// live request returning 200 + valid JSON.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import Database from 'better-sqlite3';
import { applyOpsSchema } from '../src/ops/schema.js';
import { upsertAgent, upsertStatus } from '../src/ops/queries.js';
import { startBoard, resolvePort, LAN_HOST, BIND_HOST, DEFAULT_PORT } from '../src/fleet/board.js';
import type { StartedBoard } from '../src/fleet/board.js';

const GOOD = 'serve-token';
let dir: string;
let opsPath: string;
let board: StartedBoard | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-serve-'));
  opsPath = join(dir, 'matrix-ops.db');
  const db = new Database(opsPath);
  applyOpsSchema(db);
  upsertAgent(db, { source: 'ccos', agentId: 'main', name: 'Data' }, 1000);
  upsertStatus(db, { source: 'ccos', agentId: 'main', status: 'up' }, 1000);
  db.close();

  savedEnv.MATRIX_OPS_DB = process.env.MATRIX_OPS_DB;
  savedEnv.MATRIX_OPS_TRUSTED_ROOT = process.env.MATRIX_OPS_TRUSTED_ROOT;
  savedEnv.FLEET_DASHBOARD_TOKEN = process.env.FLEET_DASHBOARD_TOKEN;
  savedEnv.PORT = process.env.PORT;
  process.env.MATRIX_OPS_DB = opsPath;
  process.env.MATRIX_OPS_TRUSTED_ROOT = dir;
  process.env.FLEET_DASHBOARD_TOKEN = GOOD;
  delete process.env.PORT;
});

afterEach(() => {
  board?.close();
  board = undefined;
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('resolvePort (C-30, C-72)', () => {
  it('defaults to DEFAULT_PORT when PORT unset', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
  });
  it('reads PORT from env', () => {
    expect(resolvePort({ PORT: '9999' })).toBe(9999);
  });
  it('accepts 0 (OS-assigned ephemeral)', () => {
    expect(resolvePort({ PORT: '0' })).toBe(0);
  });
  it('accepts the max valid port 65535', () => {
    expect(resolvePort({ PORT: '65535' })).toBe(65535);
  });
  it('falls back to default on an out-of-range port (C-72)', () => {
    expect(resolvePort({ PORT: '70000' })).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: '999999' })).toBe(DEFAULT_PORT);
  });
  it('falls back to default on a non-numeric port', () => {
    expect(resolvePort({ PORT: 'abc' })).toBe(DEFAULT_PORT);
  });
});

describe('startBoard (C-22, C-31, C-32)', () => {
  it('binds 0.0.0.0, prints the LAN URL, serves 200 JSON', async () => {
    const lines: string[] = [];
    board = await startBoard({ port: 0, log: (l) => lines.push(l) });

    // C-22: bound on 0.0.0.0 (logged) and reachable on loopback (a member of 0.0.0.0)
    expect(lines.some((l) => l.includes(`${BIND_HOST}:`))).toBe(true);

    // C-31: LAN host printed, never localhost / 127.0.0.1
    expect(lines.some((l) => l.includes(LAN_HOST))).toBe(true);
    expect(lines.some((l) => l.includes('localhost'))).toBe(false);
    expect(lines.some((l) => l.includes('127.0.0.1'))).toBe(false);

    // C-31: the secret token is never printed in full
    expect(lines.some((l) => l.includes(GOOD))).toBe(false);

    // C-32: live request returns 200 + valid JSON array
    const res = await fetch(`http://127.0.0.1:${board.port}/api/fleet?token=${GOOD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });
});

describe('startBoard EADDRINUSE (C-39, C-65)', () => {
  // Occupy a port with a plain net server, then start the board on the SAME
  // port. startBoard must REJECT with a clear bind error (the non-zero/error
  // path), not hang and not silently succeed.
  it('rejects with a clear error when the port is already in use', async () => {
    // Grab an ephemeral port we control, learn its number, keep it bound.
    const blocker: Server = await new Promise((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(0, '0.0.0.0', () => res(s));
    });
    const addr = blocker.address();
    if (addr === null || typeof addr === 'string') {
      blocker.close();
      throw new Error('could not determine blocker port');
    }
    const busyPort = addr.port;

    try {
      await expect(startBoard({ port: busyPort, log: () => {} })).rejects.toThrow(
        /EADDRINUSE|address already in use|listen/i,
      );
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});

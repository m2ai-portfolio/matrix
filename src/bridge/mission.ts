// Matrix -> CCOS bridge: the sanctioned mission-cli surface
// (docs/ROUTING.md §"The bridge").
//
// The bridge NEVER writes the live CCOS database directly. It enqueues work and
// reads completion ONLY through CCOS's sanctioned mission-cli:
//   node /opt/claudeclaw-os/dist/mission-cli.js \
//        create --agent <owner> --title <title> <prompt>
//   node .../mission-cli.js result <id>
//
// This module wraps that CLI behind a small interface (MissionApi) so the bridge
// loop depends on the interface, not on the live CCOS database. Tests inject a mock
// MissionApi; production injects the real shell-out implementation below. CCOS
// core is never modified.

import { spawnSync } from 'node:child_process';

/** A created CCOS mission task. */
export interface MissionCreated {
  id: string;
}

/** The status + result of a CCOS mission task, parsed from `mission-cli result`. */
export interface MissionResult {
  id: string;
  /** queued | running | completed | failed | cancelled | unknown */
  status: string;
  /** The agent's result text, present once status is terminal-success. */
  result: string | null;
  /** Error text, present when the task failed. */
  error: string | null;
}

/**
 * The bridge's only dependency on CCOS. Two methods mirror the two sanctioned
 * mission-cli verbs the bridge is allowed to use (create + result). No raw DB.
 */
export interface MissionApi {
  create(input: {
    agent: string;
    title: string;
    prompt: string;
    priority?: number;
  }): Promise<MissionCreated>;
  result(id: string): Promise<MissionResult>;
}

/**
 * Default claudeclaw-os checkout directory. mission-cli auto-loads its env
 * (DB_ENCRYPTION_KEY + .env/.env.shared) relative to THIS directory, so the
 * shell-out must spawn with cwd set here regardless of the caller's cwd.
 * Override via the CLAUDECLAW_DIR env var or the `ccosDir` option.
 */
export const DEFAULT_CLAUDECLAW_DIR = '/opt/claudeclaw-os';

/** Resolve the claudeclaw-os dir: explicit opt > CLAUDECLAW_DIR env > default. */
export function resolveCcosDir(ccosDir?: string): string {
  return ccosDir ?? process.env.CLAUDECLAW_DIR ?? DEFAULT_CLAUDECLAW_DIR;
}

/** Default path to the built CCOS mission-cli, relative to the claudeclaw-os dir. */
export const DEFAULT_MISSION_CLI = '/opt/claudeclaw-os/dist/mission-cli.js';

export interface ShellMissionApiOptions {
  /** Path to mission-cli.js. Defaults to DEFAULT_MISSION_CLI. */
  cliPath?: string;
  /** node binary. Defaults to process.execPath. */
  nodePath?: string;
  /**
   * claudeclaw-os checkout dir used as the spawn `cwd` so mission-cli loads its
   * own env (DB_ENCRYPTION_KEY, .env/.env.shared) independent of the launch cwd.
   * Defaults to CLAUDECLAW_DIR env var, then DEFAULT_CLAUDECLAW_DIR.
   */
  ccosDir?: string;
  /** Injectable runner for tests; defaults to spawnSync. */
  run?: (args: string[]) => {
    stdout: string;
    stderr: string;
    status: number | null;
  };
}

/** Parse `mission-cli create` stdout: "Mission task created: <id>". */
export function parseCreate(stdout: string): MissionCreated {
  const m = stdout.match(/Mission task created:\s*([0-9a-f]+)/i);
  if (!m) throw new Error(`could not parse mission-cli create output: ${stdout.slice(0, 200)}`);
  return { id: m[1] };
}

/**
 * Parse `mission-cli result <id>` stdout. Shape (see CCOS mission-cli.ts):
 *   Task:   <id> [<status>]
 *   Title:  ...
 *   Agent:  ...
 *
 *   Result:
 *   <result text...>
 * or "Error: <text>" or "No result yet.".
 */
export function parseResult(stdout: string, id: string): MissionResult {
  const statusMatch = stdout.match(/Task:\s*\S+\s*\[([^\]]+)\]/);
  const status = statusMatch ? statusMatch[1].trim() : 'unknown';

  let result: string | null = null;
  let error: string | null = null;

  const resultIdx = stdout.indexOf('\nResult:\n');
  const errorIdx = stdout.indexOf('\nError:');
  if (resultIdx !== -1) {
    result = stdout.slice(resultIdx + '\nResult:\n'.length).trim();
    if (result === '') result = null;
  } else if (errorIdx !== -1) {
    error = stdout.slice(errorIdx + '\nError:'.length).trim();
    if (error === '') error = null;
  }

  return { id, status, result, error };
}

/**
 * Production MissionApi: shells out to the CCOS mission-cli. Writes nothing to
 * the claudeclaw-os tree; only invokes the CLI. The CLI itself owns all DB I/O.
 */
export function createShellMissionApi(opts: ShellMissionApiOptions = {}): MissionApi {
  const cliPath = opts.cliPath ?? DEFAULT_MISSION_CLI;
  const nodePath = opts.nodePath ?? process.execPath;
  const ccosDir = resolveCcosDir(opts.ccosDir);
  const run =
    opts.run ??
    ((args: string[]) => {
      // cwd MUST be the claudeclaw-os dir so mission-cli auto-loads its env
      // (DB_ENCRYPTION_KEY + .env/.env.shared) — an unattended loop cannot rely
      // on being launched from that directory. env is passed through so the
      // process inherits PATH and any already-exported keys.
      const r = spawnSync(nodePath, [cliPath, ...args], {
        encoding: 'utf8',
        cwd: ccosDir,
        env: process.env,
      });
      return {
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        status: r.status,
      };
    });

  return {
    async create({ agent, title, prompt, priority }) {
      const args = ['create', '--agent', agent, '--title', title];
      if (priority !== undefined) args.push('--priority', String(priority));
      args.push(prompt);
      const { stdout, stderr, status } = run(args);
      if (status !== 0) {
        throw new Error(`mission-cli create failed (exit ${status}): ${stderr || stdout}`);
      }
      return parseCreate(stdout);
    },
    async result(id) {
      const { stdout, stderr, status } = run(['result', id]);
      if (status !== 0) {
        throw new Error(`mission-cli result failed (exit ${status}): ${stderr || stdout}`);
      }
      return parseResult(stdout, id);
    },
  };
}

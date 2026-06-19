// Matrix -> CCOS bridge: daemon-readiness tests (docs/ROUTING.md §"The bridge").
//
// Covers the cwd/env fix that makes the shell-out independent of launch cwd:
//   - createShellMissionApi spawns mission-cli with cwd = claudeclaw-os dir
//     (so mission-cli auto-loads DB_ENCRYPTION_KEY + .env/.env.shared) and
//     passes env through.
//   - CLAUDECLAW_DIR env var and the ccosDir option override the default.
//   - the run.ts launchable entry resolves config from env vars.
//
// spawnSync is mocked via vi.mock so no real mission-cli / claudeclaw.db / DB is
// touched. These complement routing-bridge.test.ts (which injects a mock
// MissionApi and never exercises the real spawn path).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture spawnSync calls. The factory must not reference outer vars except via
// the hoisted mock, so we read calls back through the imported mock below.
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Import AFTER the mock is registered.
import {
  createShellMissionApi,
  resolveCcosDir,
  DEFAULT_CLAUDECLAW_DIR,
} from '../src/bridge/mission.js';
import { resolveRunConfig, DEFAULT_AGENT_ID } from '../src/bridge/run.js';

beforeEach(() => {
  spawnSyncMock.mockReset();
});
afterEach(() => {
  delete process.env.CLAUDECLAW_DIR;
});

describe('createShellMissionApi cwd/env (daemon readiness)', () => {
  it('spawns mission-cli with cwd = default claudeclaw-os dir and passes env through', async () => {
    spawnSyncMock.mockReturnValue({
      stdout: 'Mission task created: abc123\n',
      stderr: '',
      status: 0,
    });

    const api = createShellMissionApi();
    const created = await api.create({
      agent: 'galvatron',
      title: 't',
      prompt: 'do it',
    });
    expect(created.id).toBe('abc123');

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv },
    ];
    expect(args[0]).toMatch(/mission-cli\.js$/);
    // The critical invariant: cwd is the claudeclaw-os dir, NOT the caller cwd.
    expect(options.cwd).toBe(DEFAULT_CLAUDECLAW_DIR);
    // env is passed through (so PATH + any exported keys are inherited).
    expect(options.env).toBe(process.env);
  });

  it('honors the ccosDir option as the spawn cwd', async () => {
    spawnSyncMock.mockReturnValue({
      stdout: 'Task:   abc123 [queued]\nTitle: x\nAgent: g\n\nNo result yet.',
      stderr: '',
      status: 0,
    });

    const api = createShellMissionApi({ ccosDir: '/custom/ccos/dir' });
    await api.result('abc123');

    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(options.cwd).toBe('/custom/ccos/dir');
  });

  it('falls back to CLAUDECLAW_DIR env var when no option is given', async () => {
    process.env.CLAUDECLAW_DIR = '/env/ccos/dir';
    spawnSyncMock.mockReturnValue({
      stdout: 'Mission task created: deadbeef\n',
      stderr: '',
      status: 0,
    });

    const api = createShellMissionApi();
    await api.create({ agent: 'g', title: 't', prompt: 'p' });

    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(options.cwd).toBe('/env/ccos/dir');
  });
});

describe('resolveCcosDir precedence', () => {
  it('explicit option wins over env and default', () => {
    process.env.CLAUDECLAW_DIR = '/env/dir';
    expect(resolveCcosDir('/explicit/dir')).toBe('/explicit/dir');
  });
  it('env var wins over default when no option', () => {
    process.env.CLAUDECLAW_DIR = '/env/dir';
    expect(resolveCcosDir()).toBe('/env/dir');
  });
  it('falls back to the default with neither', () => {
    delete process.env.CLAUDECLAW_DIR;
    expect(resolveCcosDir()).toBe(DEFAULT_CLAUDECLAW_DIR);
  });
});

describe('run.ts resolveRunConfig (launchable entry)', () => {
  it('uses defaults when no env vars are set', () => {
    const cfg = resolveRunConfig({});
    expect(cfg.agentId).toBe(DEFAULT_AGENT_ID);
    expect(cfg.ccosDir).toBe(DEFAULT_CLAUDECLAW_DIR);
    expect(cfg.maxPasses).toBe(100);
    expect(cfg.queueRoot).toMatch(/queue$/);
  });

  it('reads agent/queueRoot/ccosDir/maxPasses from env', () => {
    const cfg = resolveRunConfig({
      BRIDGE_AGENT_ID: 'kup',
      MATRIX_QUEUE_ROOT: '/q/root',
      CLAUDECLAW_DIR: '/c/dir',
      BRIDGE_MAX_PASSES: '7',
    });
    expect(cfg.agentId).toBe('kup');
    expect(cfg.queueRoot).toBe('/q/root');
    expect(cfg.ccosDir).toBe('/c/dir');
    expect(cfg.maxPasses).toBe(7);
  });

  it('ignores a non-numeric or non-positive maxPasses', () => {
    expect(resolveRunConfig({ BRIDGE_MAX_PASSES: 'abc' }).maxPasses).toBe(100);
    expect(resolveRunConfig({ BRIDGE_MAX_PASSES: '0' }).maxPasses).toBe(100);
  });
});

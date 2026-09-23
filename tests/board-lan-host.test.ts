// LAN_HOST resolution: MATRIX_LAN_HOST override, RFC 1918 detection, never localhost.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('node:os');
});

describe('LAN_HOST', () => {
  it('uses MATRIX_LAN_HOST when set', async () => {
    vi.stubEnv('MATRIX_LAN_HOST', '192.168.50.7');
    const { LAN_HOST } = await import('../src/fleet/board.js');
    expect(LAN_HOST).toBe('192.168.50.7');
  });

  it('detects the first private IPv4 and skips loopback, CGNAT and public', async () => {
    vi.stubEnv('MATRIX_LAN_HOST', '');
    vi.doMock('node:os', () => ({
      networkInterfaces: () => ({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
        tailscale0: [{ family: 'IPv4', internal: false, address: '100.94.1.2' }],
        eth1: [{ family: 'IPv4', internal: false, address: '203.0.113.9' }],
        wlan0: [{ family: 'IPv4', internal: false, address: '172.20.0.5' }],
      }),
    }));
    const { LAN_HOST } = await import('../src/fleet/board.js');
    expect(LAN_HOST).toBe('172.20.0.5');
  });

  it('falls back to the bind address, never localhost, when no LAN IPv4 exists', async () => {
    vi.stubEnv('MATRIX_LAN_HOST', '');
    vi.doMock('node:os', () => ({
      networkInterfaces: () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }),
    }));
    const { LAN_HOST } = await import('../src/fleet/board.js');
    expect(LAN_HOST).toBe('0.0.0.0');
  });
});

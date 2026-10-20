import { describe, expect, it, vi } from 'vitest';

const listManagedServers = vi.hoisted(() => vi.fn());
const findFreePort = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-servers/servers-store', () => ({ listManagedServers }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../free-port', () => ({ findFreePort }));

const { pickRemoteFreePorts } = await import('./remote-free-port');

describe('pickRemoteFreePorts', () => {
  it('avoids every port another managed server is registered on, and what the host listens on', async () => {
    listManagedServers.mockResolvedValue([
      { url: 'http://localhost:41001', dashboardUrl: 'http://localhost:41000' },
      // A stack registered without a dashboard of its own claims only its address.
      { url: 'http://localhost:42001', dashboardUrl: null },
    ]);
    const seen: Set<number>[] = [];
    let next = 50000;
    findFreePort.mockImplementation(async (taken: Set<number>) => {
      seen.push(new Set(taken));
      return next++;
    });
    const ctx = { exec: vi.fn(async () => ({ stdout: 'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n' })) };

    const ports = await pickRemoteFreePorts(ctx as never);

    expect(ports).toEqual({ gateway: 50000, api: 50001, mattermost: 50002, postgres: 50003 });
    expect(seen[0]).toEqual(new Set([41001, 41000, 42001, 5432]));
  });
});

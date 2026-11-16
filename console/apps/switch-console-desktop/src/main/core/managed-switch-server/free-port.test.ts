import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { explainStartFailure } from '@shared/core/managed-switch-server/start-failure';
import {
  apiUrlFor,
  assertIpv6LoopbackFree,
  gatewayUrlFor,
  ipv6LoopbackHeld,
  isPorts,
  managedServerAddresses,
  pickFreePorts,
} from './free-port';

describe('pickFreePorts', () => {
  it('returns four distinct, positive host ports', async () => {
    const ports = await pickFreePorts();
    const values = [ports.gateway, ports.api, ports.mattermost, ports.postgres];
    for (const p of values) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(65536);
    }
    expect(new Set(values).size).toBe(4);
  });
});

describe('isPorts', () => {
  it('accepts a complete numeric port set', () => {
    expect(isPorts({ gateway: 1, api: 2, mattermost: 3, postgres: 4 })).toBe(true);
  });

  it('rejects partial or non-numeric shapes', () => {
    expect(isPorts({ gateway: 1, api: 2, mattermost: 3 })).toBe(false);
    expect(isPorts({ gateway: '1', api: 2, mattermost: 3, postgres: 4 })).toBe(false);
    expect(isPorts(null)).toBe(false);
    expect(isPorts('nope')).toBe(false);
  });
});

describe('url helpers', () => {
  it('build loopback URLs from the chosen ports', () => {
    const ports = { gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 };
    expect(gatewayUrlFor(ports)).toBe('http://127.0.0.1:3300');
    expect(apiUrlFor(ports)).toBe('http://127.0.0.1:8000');
  });

  it('registers a managed stack on switch-core’s port, with the dashboard on its own', () => {
    const ports = { gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 };
    expect(managedServerAddresses(ports)).toEqual({
      url: 'http://127.0.0.1:8000',
      dashboardUrl: 'http://127.0.0.1:3300',
    });
  });
});

/** Listen on `host:port` (0 for any free port) and return the port. */
function listen(server: Server | NetServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only: host === '::1' }, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/** Whether this machine has an IPv6 loopback at all. */
async function hasIpv6Loopback(): Promise<boolean> {
  const probe = createServer();
  try {
    await listen(probe, '::1', 0);
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

describe.runIf(await hasIpv6Loopback())('an impostor on the IPv6 loopback', () => {
  const servers: Array<Server | NetServer> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('never gets a request for the managed server, which Console addresses as 127.0.0.1', async () => {
    const real = createHttpServer((_req, res) => res.end('real'));
    servers.push(real);
    const port = await listen(real, '127.0.0.1', 0);
    const impostor = createHttpServer((_req, res) => res.end('impostor'));
    servers.push(impostor);
    await listen(impostor, '::1', port);

    const response = await fetch(
      `${apiUrlFor({ gateway: 1, api: port, mattermost: 3, postgres: 4 })}/`
    );
    expect(await response.text()).toBe('real');
  });

  it('stops a start, in words that offer another port', async () => {
    const impostor = createServer();
    servers.push(impostor);
    const port = await listen(impostor, '::1', 0);

    await expect(ipv6LoopbackHeld(port)).resolves.toBe(true);
    const error = await assertIpv6LoopbackFree([port]).then(
      () => null,
      (reason: unknown) => reason as Error
    );
    expect(error?.message).toContain(`bind [::1]:${port}: address already in use`);
    expect(explainStartFailure(error?.message ?? '').port).toBe(port);
  });

  it('does not count the stack’s own IPv4 listener as one', async () => {
    const own = createServer();
    servers.push(own);
    const port = await listen(own, '127.0.0.1', 0);

    await expect(ipv6LoopbackHeld(port)).resolves.toBe(false);
    await expect(assertIpv6LoopbackFree([port])).resolves.toBeUndefined();
  });
});

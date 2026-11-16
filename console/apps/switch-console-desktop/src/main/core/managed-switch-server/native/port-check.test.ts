import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { explainStartFailure } from '@shared/core/managed-switch-server/start-failure';
import { findFreePort, type LocalServerPorts } from '../free-port';
import { assertPortsFree } from './port-check';

const held: Server[] = [];

/** Listen on `port` on loopback, as another program would. */
function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
    held.push(server);
  });
}

async function freePorts(): Promise<LocalServerPorts> {
  const taken = new Set<number>();
  return {
    gateway: await findFreePort(taken),
    api: await findFreePort(taken),
    mattermost: await findFreePort(taken),
    postgres: await findFreePort(taken),
  };
}

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('assertPortsFree', () => {
  it('passes when every port the server listens on is free', async () => {
    await expect(assertPortsFree(await freePorts(), true)).resolves.toBeUndefined();
  });

  it('refuses a start whose callback (gateway) port another program holds, naming the port', async () => {
    const ports = await freePorts();
    await hold(ports.gateway);

    const failure = await assertPortsFree(ports, false).then(
      () => null,
      (error: Error) => error.message
    );

    expect(failure).not.toBeNull();
    const explained = explainStartFailure(failure!);
    expect(explained.port).toBe(ports.gateway);
    expect(explained.hint).toBe(
      `Another program is using port ${ports.gateway}. Quit it, or use another port, then try again.`
    );
  });

  it('checks Mattermost’s port only when Mattermost runs', async () => {
    const ports = await freePorts();
    await hold(ports.mattermost);

    await expect(assertPortsFree(ports, false)).resolves.toBeUndefined();
    await expect(assertPortsFree(ports, true)).rejects.toThrow(
      `bind 127.0.0.1:${ports.mattermost}: address already in use`
    );
  });
});

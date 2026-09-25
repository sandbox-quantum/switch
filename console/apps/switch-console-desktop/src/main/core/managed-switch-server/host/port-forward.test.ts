import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { PortForwarder } = await import('./port-forward');

function occupy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe('PortForwarder', () => {
  it('says which port is taken here, and why it has to be that one', async () => {
    // A stack set up from another computer publishes ports that computer found
    // free; this one may already be using them (CHOO-2893).
    const { server, port } = await occupy();
    opened.push(server);
    const forwarder = new PortForwarder({} as SshClientProxy, 'vm-1');

    await expect(forwarder.start([port])).rejects.toThrow(
      new RegExp(
        `Port ${port} is already in use on this computer, so the Switch server on vm-1 ` +
          `cannot be reached from here\\..*same port number`
      )
    );
  });

  it('releases the ports it did bind when a later one is taken', async () => {
    const { server, port: taken } = await occupy();
    opened.push(server);
    const { server: probe, port: free } = await occupy();
    await new Promise((r) => probe.close(() => r(null)));
    const forwarder = new PortForwarder({} as SshClientProxy, 'vm-1');

    await expect(forwarder.start([free, taken])).rejects.toThrow(/already in use/);

    // The first listener was torn down with the failure, so its port is free.
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(free, '127.0.0.1', () => resolve());
    });
    opened.push(again);
  });
});

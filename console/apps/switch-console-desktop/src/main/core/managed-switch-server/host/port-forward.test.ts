import { connect, createServer, type Server } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn: logWarn, info: vi.fn() } }));

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

  it('carries a connection through to the same port on the host', async () => {
    const { server: probe, port } = await occupy();
    await new Promise((r) => probe.close(() => r(null)));
    // The host's end of the channel: echoes what it is sent, upper-cased.
    const channel = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        this.push(chunk.toString().toUpperCase());
        done();
      },
    });
    const forwardOut = vi.fn(async () => channel);
    const forwarder = new PortForwarder({ forwardOut } as unknown as SshClientProxy, 'vm-1');
    await forwarder.start([port]);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('hello'));
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once('error', reject);
    });
    forwarder.stop();

    expect(forwardOut).toHaveBeenCalledWith(port);
    expect(reply).toBe('HELLO');
  });

  it('closes the connection, and says why, when the host will not open a channel', async () => {
    const { server: probe, port } = await occupy();
    await new Promise((r) => probe.close(() => r(null)));
    const forwardOut = vi.fn(async () => {
      throw new Error('administratively prohibited');
    });
    const forwarder = new PortForwarder({ forwardOut } as unknown as SshClientProxy, 'vm-1');
    await forwarder.start([port]);

    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => {});
      socket.once('close', () => resolve());
    });
    forwarder.stop();

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`could not open channel to remote :${port} \\(vm-1\\)`)),
      expect.objectContaining({ err: expect.any(Error) })
    );
  });

  it('stops listening when stopped, and can be stopped twice', async () => {
    const { server: probe, port } = await occupy();
    await new Promise((r) => probe.close(() => r(null)));
    const forwarder = new PortForwarder({} as SshClientProxy, 'vm-1');
    await forwarder.start([port]);

    forwarder.stop();
    forwarder.stop();

    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(port, '127.0.0.1', () => resolve());
    });
    opened.push(again);
  });
});

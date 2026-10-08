import { EventEmitter } from 'node:events';
import type * as Net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';

/**
 * A real socket cannot portably fail to bind for a reason other than being taken
 * (a low port is refused on Linux, allowed on macOS), so the listener is faked.
 */

class RefusingServer extends EventEmitter {
  listen() {
    const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:80'), {
      code: 'EACCES',
    });
    queueMicrotask(() => this.emit('error', error));
    return this;
  }
  close() {}
}

vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof Net>()),
  createServer: () => new RefusingServer(),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { PortForwarder } = await import('./port-forward');

describe('PortForwarder', () => {
  it('passes on why a port could not be bound when it is not that it is taken', async () => {
    const forwarder = new PortForwarder({} as SshClientProxy, 'vm-1');

    await expect(forwarder.start([80])).rejects.toThrow(
      'cannot bind local port 80 for vm-1: listen EACCES: permission denied 127.0.0.1:80'
    );
  });
});

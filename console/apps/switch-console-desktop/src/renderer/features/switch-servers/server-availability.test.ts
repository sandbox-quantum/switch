import { beforeEach, describe, expect, it, vi } from 'vitest';

const serversStore = vi.hoisted(() => ({
  servers: [] as { id: string; managed?: boolean; managementKind?: string; sshHost?: string }[],
  connected: new Set<string>(),
  unreachable: new Set<string>(),
  isConnected(serverId: string): boolean {
    return this.connected.has(serverId);
  },
  isUnreachable(serverId: string): boolean {
    return this.unreachable.has(serverId);
  },
}));

const localStore = vi.hoisted(() => ({ isRunning: true }));

vi.mock('./switch-servers-store', () => ({ switchServersStore: serversStore }));
vi.mock('./local-server-store', () => ({ localServerStore: localStore }));
vi.mock('./remote-server-store', () => ({ remoteServerStore: { isRunning: () => true } }));

const { serverAvailability } = await import('./server-availability');

beforeEach(() => {
  serversStore.servers = [{ id: 'srv-a' }];
  serversStore.connected.clear();
  serversStore.unreachable.clear();
  localStore.isRunning = true;
});

describe('why a server is unavailable', () => {
  it('reads as available when signed in', () => {
    serversStore.connected.add('srv-a');

    expect(serverAvailability('srv-a')).toBe('available');
  });

  it('reads as signed-out when it answers but nobody is signed in', () => {
    expect(serverAvailability('srv-a')).toBe('signed-out');
  });

  it('reads as unreachable rather than signed-out when it does not answer', () => {
    // These are not the same problem. Signed-out is fixed by the user signing
    // in; unreachable cannot be, so the sidebar must not offer "Sign in" for it.
    serversStore.unreachable.add('srv-a');

    expect(serverAvailability('srv-a')).toBe('unreachable');
  });

  it('prefers a live connection over a stale unreachable flag', () => {
    serversStore.connected.add('srv-a');
    serversStore.unreachable.add('srv-a');

    expect(serverAvailability('srv-a')).toBe('available');
  });

  it('reads a stopped managed stack as dormant, not unreachable', () => {
    // Nothing is wrong with a stack the user has not started.
    serversStore.servers = [{ id: 'srv-a', managed: true, managementKind: 'local' }];
    serversStore.unreachable.add('srv-a');
    localStore.isRunning = false;

    expect(serverAvailability('srv-a')).toBe('dormant');
  });
});

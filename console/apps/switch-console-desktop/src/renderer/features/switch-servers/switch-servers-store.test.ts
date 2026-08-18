import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const getAuthConfig = vi.hoisted(() => vi.fn());
const getConnectionStatus = vi.hoisted(() => vi.fn());
const listServers = vi.hoisted(() => vi.fn());
const getActiveServerId = vi.hoisted(() => vi.fn());
const setActiveServer = vi.hoisted(() => vi.fn());
const removeServer = vi.hoisted(() => vi.fn());
const addServer = vi.hoisted(() => vi.fn());
/** SSH hosts the reachability manager currently considers down. */
const blockedHosts = vi.hoisted(() => new Set<string>());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    switchServers: {
      getAuthConfig,
      getConnectionStatus,
      listServers,
      getActiveServerId,
      setActiveServer,
      removeServer,
      addServer,
    },
  },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: { isBlocked: (sshHost: string) => blockedHosts.has(sshHost) },
}));
const revalidate = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { revalidate } },
}));

const { SwitchServersStore } = await import('./switch-servers-store');

const authConfig = { passwordLoginEnabled: true, oidcEnabled: false, oidcProviderLabel: null };

function server(id: string, overrides: Partial<SwitchServer> = {}): SwitchServer {
  return {
    id,
    name: id,
    gatewayUrl: `https://${id}.example.com`,
    apiUrl: `https://api.${id}.example.com`,
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function remoteServer(id: string, sshHost: string): SwitchServer {
  return server(id, { managed: true, managementKind: 'remote', sshHost });
}

function newStore(servers: SwitchServer[]) {
  const store = new SwitchServersStore();
  store.servers = servers;
  return store;
}

/** A promise the test resolves by hand, to hold a fetch in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  blockedHosts.clear();
  // The store logs the raw gateway error rather than showing it. Expected here.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getConnectionStatus.mockImplementation(async (serverId: string) => ({
    serverId,
    connected: false,
    user: null,
  }));
  getAuthConfig.mockResolvedValue(authConfig);
});

describe('fetching sign-in options', () => {
  it('asks again after a failed fetch', async () => {
    // The bug: one blip while the page mounted left the sign-in panel stuck on
    // "Checking sign-in options…" for good, because nothing ever re-asked.
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('offline'));

    await store.ensureAuthConfig('srv-a');
    expect(store.authConfigFor('srv-a')).toBeNull();

    await store.ensureAuthConfig('srv-a');
    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });

  it('does not ask again once it has an answer', async () => {
    const store = newStore([server('srv-a')]);

    await store.ensureAuthConfig('srv-a');
    await store.ensureAuthConfig('srv-a');

    expect(getAuthConfig).toHaveBeenCalledTimes(1);
  });

  it('collapses overlapping asks into one request', async () => {
    // Several recovery signals can land together — a window focus while the
    // page is mounting, say. That must not become several identical fetches.
    const store = newStore([server('srv-a')]);
    const inFlight = deferred<typeof authConfig>();
    getAuthConfig.mockReturnValueOnce(inFlight.promise);

    const first = store.ensureAuthConfig('srv-a');
    const second = store.ensureAuthConfig('srv-a');
    inFlight.resolve(authConfig);
    await Promise.all([first, second]);

    expect(getAuthConfig).toHaveBeenCalledTimes(1);
    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });
});

describe('recovering when connectivity returns', () => {
  it('re-drives a sign-in fetch that never landed', async () => {
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('offline'));
    await store.ensureAuthConfig('srv-a');

    await store.recoverStale();

    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });

  it('leaves servers no login panel has asked about alone', async () => {
    // Recovery rides the status sweep, which covers every server. Fetching an
    // auth config for all of them would be new traffic nobody asked for.
    const store = newStore([server('srv-a'), server('srv-b')]);
    getAuthConfig.mockRejectedValueOnce(new Error('offline'));
    await store.ensureAuthConfig('srv-a');
    getAuthConfig.mockClear();

    await store.recoverStale();

    expect(getAuthConfig).toHaveBeenCalledTimes(1);
    expect(getAuthConfig).toHaveBeenCalledWith('srv-a');
  });

  it('refreshes connection status as well', async () => {
    const store = newStore([server('srv-a'), server('srv-b')]);

    await store.recoverStale();

    expect(getConnectionStatus).toHaveBeenCalledWith('srv-a');
    expect(getConnectionStatus).toHaveBeenCalledWith('srv-b');
  });

  it('stops retrying a server that was removed', async () => {
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('offline'));
    await store.ensureAuthConfig('srv-a');
    listServers.mockResolvedValue([]);
    getActiveServerId.mockResolvedValue(null);
    removeServer.mockResolvedValue(undefined);

    await store.removeServer('srv-a');
    getAuthConfig.mockClear();
    await store.recoverStale();

    expect(getAuthConfig).not.toHaveBeenCalled();
  });
});

describe('a page left on a server that is gone', () => {
  it('is revalidated when the server is removed', async () => {
    const store = newStore([server('srv-a')]);
    listServers.mockResolvedValue([]);
    getActiveServerId.mockResolvedValue(null);
    removeServer.mockResolvedValue(undefined);

    await store.removeServer('srv-a');

    expect(revalidate).toHaveBeenCalled();
  });

  it('is revalidated once the list is known, not before', async () => {
    const store = new SwitchServersStore();
    expect(store.loaded).toBe(false);

    listServers.mockResolvedValue([server('srv-a')]);
    getActiveServerId.mockResolvedValue('srv-a');
    await store.init();

    expect(store.loaded).toBe(true);
    expect(revalidate).toHaveBeenCalled();
  });
});

describe('a server on an unreachable host', () => {
  it('skips the doomed fetch without raising the error banner', async () => {
    blockedHosts.add('host-1');
    const store = newStore([remoteServer('srv-a', 'host-1')]);

    await store.ensureAuthConfig('srv-a');

    expect(getAuthConfig).not.toHaveBeenCalled();
    expect(store.error).toBeNull();
  });

  it('is asked again once the host comes back', async () => {
    // The host un-blocking is the recovery signal here. Before, the page just
    // swapped the host-unreachable panel for the stuck sign-in panel.
    blockedHosts.add('host-1');
    const store = newStore([remoteServer('srv-a', 'host-1')]);
    await store.ensureAuthConfig('srv-a');

    blockedHosts.delete('host-1');
    await store.ensureAuthConfig('srv-a');

    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });
});

describe('the manual refresh button', () => {
  it('re-checks sign-in options, not just connection status', async () => {
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('offline'));
    await store.ensureAuthConfig('srv-a');

    await store.refreshServer('srv-a');

    expect(getConnectionStatus).toHaveBeenCalledWith('srv-a');
    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });
});

describe('a server that cannot be reached', () => {
  it('is flagged when the sign-in read fails', async () => {
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('fetch failed'));

    await store.ensureAuthConfig('srv-a');

    expect(store.isUnreachable('srv-a')).toBe(true);
  });

  it('is flagged when the status read fails', async () => {
    const store = newStore([server('srv-a')]);
    getConnectionStatus.mockRejectedValueOnce(new Error('fetch failed'));

    await store.refreshStatus('srv-a');

    expect(store.isUnreachable('srv-a')).toBe(true);
  });

  it('never puts the raw gateway error in the banner', async () => {
    // What used to reach the user: "Error invoking remote method
    // 'switchServers.getAuthConfig': GatewayError: ... fetch failed". Our own
    // IPC method name is not something anyone can act on.
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(
      new Error("Error invoking remote method 'switchServers.getAuthConfig': fetch failed")
    );

    await store.ensureAuthConfig('srv-a');

    expect(store.error).toBeNull();
  });

  it('clears the flag once it answers again', async () => {
    const store = newStore([server('srv-a')]);
    getAuthConfig.mockRejectedValueOnce(new Error('fetch failed'));
    getConnectionStatus.mockRejectedValueOnce(new Error('fetch failed'));
    await store.refreshServer('srv-a');
    expect(store.isUnreachable('srv-a')).toBe(true);

    await store.refreshServer('srv-a');

    expect(store.isUnreachable('srv-a')).toBe(false);
    expect(store.authConfigFor('srv-a')).toEqual(authConfig);
  });

  it('is flagged per server, not across the app', async () => {
    const store = newStore([server('srv-a'), server('srv-b')]);
    getConnectionStatus.mockImplementation(async (serverId: string) => {
      if (serverId === 'srv-a') throw new Error('fetch failed');
      return { serverId, connected: false, user: null };
    });

    await store.refreshAllStatuses();

    expect(store.isUnreachable('srv-a')).toBe(true);
    expect(store.isUnreachable('srv-b')).toBe(false);
  });
});

/**
 * A server is a workspace: the switcher, the sidebar and the sessions under it
 * all read the active one, so "servers exist but none is active" is a state the
 * UI cannot render. Nothing on the main side picks one, so the store must.
 */
describe('keeping a server active', () => {
  it('selects the first server when nothing was active', async () => {
    listServers.mockResolvedValue([server('srv-a'), server('srv-b')]);
    getActiveServerId.mockResolvedValue(null);
    const store = new SwitchServersStore();

    await store.init();

    expect(store.activeServerId).toBe('srv-a');
  });

  it('keeps the server the user last chose', async () => {
    listServers.mockResolvedValue([server('srv-a'), server('srv-b')]);
    getActiveServerId.mockResolvedValue('srv-b');
    const store = new SwitchServersStore();

    await store.init();

    expect(store.activeServerId).toBe('srv-b');
  });

  it('re-selects when the stored server no longer exists', async () => {
    // Removing the active server and adding another leaves the stored id
    // naming the removed one. Reading that as a selection left the app with no
    // workspace at all — no switcher, no destinations, no sidebar tree — while
    // a perfectly good server sat in the list.
    listServers.mockResolvedValue([server('srv-b')]);
    getActiveServerId.mockResolvedValue('srv-gone');
    const store = new SwitchServersStore();

    await store.init();

    expect(store.activeServerId).toBe('srv-b');
    expect(store.activeServer?.id).toBe('srv-b');
  });

  it('activates the first server added, which nothing else does', async () => {
    // Adding a server does not set it active on the main side, so without this
    // the very first one left the app with no workspace to show — the sidebar
    // stayed on "Add a server" until the next launch.
    listServers.mockResolvedValue([]);
    getActiveServerId.mockResolvedValue(null);
    const store = new SwitchServersStore();
    await store.init();

    const created = server('srv-new');
    addServer.mockResolvedValue(created);
    listServers.mockResolvedValue([created]);

    await store.addServer('New', created.gatewayUrl, created.apiUrl);

    expect(store.activeServerId).toBe('srv-new');
  });

  it('does not move the workspace when a second server is added', async () => {
    listServers.mockResolvedValue([server('srv-a')]);
    getActiveServerId.mockResolvedValue('srv-a');
    const store = new SwitchServersStore();
    await store.init();

    const created = server('srv-b');
    addServer.mockResolvedValue(created);
    listServers.mockResolvedValue([server('srv-a'), created]);

    await store.addServer('B', created.gatewayUrl, created.apiUrl);

    expect(store.activeServerId).toBe('srv-a');
  });

  it('leaves nothing active when there are no servers at all', async () => {
    listServers.mockResolvedValue([]);
    getActiveServerId.mockResolvedValue(null);
    const store = new SwitchServersStore();

    await store.init();

    expect(store.activeServerId).toBeNull();
    expect(store.activeServer).toBeNull();
  });
});

describe('the error banner', () => {
  it('survives a background refresh, which cannot tell whether it is stale', async () => {
    // A rejected password lives in the same field. A background sweep clearing
    // it would delete the one thing telling the user what went wrong.
    const store = newStore([server('srv-a')]);
    await store.ensureAuthConfig('srv-a');
    store.error = 'Invalid email or password';

    await store.recoverStale();

    expect(store.error).toBe('Invalid email or password');
  });
});

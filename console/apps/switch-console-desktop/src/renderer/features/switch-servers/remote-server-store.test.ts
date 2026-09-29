import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer's side of shared remote servers (CHOO-2893): looking before
 * offering anything, joining without starting, and leaving without deleting.
 */

const rpcRemote = vi.hoisted(() => ({
  probe: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  register: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  cancelWait: vi.fn(),
  refresh: vi.fn(),
  getStatuses: vi.fn(),
}));
const agentsLoad = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const serversInit = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const forgetRemovedServer = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const isBlocked = vi.hoisted(() => vi.fn(() => false));

const statusListeners = vi.hoisted(() => [] as ((status: unknown) => void)[]);
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { remoteSwitchServer: rpcRemote },
  events: {
    on: (_channel: unknown, listener: (status: unknown) => void) => {
      statusListeners.push(listener);
      return () => {};
    },
  },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: agentsLoad },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: { isBlocked, hydrate: vi.fn() },
}));
vi.mock('./switch-servers-store', () => ({
  switchServersStore: { init: serversInit, forgetRemovedServer },
}));

const { RemoteServerStore } = await import('./remote-server-store');

const REGISTER = { self: 'me', consoles: [], activity: [] };

beforeEach(() => {
  vi.clearAllMocks();
  isBlocked.mockReturnValue(false);
  rpcRemote.register.mockResolvedValue(REGISTER);
});

describe('probe', () => {
  it('keeps what the host has, for the setup step to decide on', async () => {
    rpcRemote.probe.mockResolvedValue({
      kind: 'present',
      running: true,
      deployedVersion: '0.27.0',
      shared: true,
    });
    const store = new RemoteServerStore();

    const pending = store.probe('vm-1');
    expect(store.isProbing('vm-1')).toBe(true);
    await pending;

    expect(store.isProbing('vm-1')).toBe(false);
    expect(store.probeFor('vm-1')).toEqual({
      kind: 'present',
      running: true,
      deployedVersion: '0.27.0',
      shared: true,
    });
  });

  it('records Docker being unavailable where the Docker notice reads it', async () => {
    rpcRemote.probe.mockResolvedValue({
      kind: 'docker-unavailable',
      reason: 'daemon-down',
      detail: 'no daemon',
    });
    const store = new RemoteServerStore();

    await store.probe('vm-1');

    expect(store.dockerFor('vm-1')).toEqual({
      available: false,
      reason: 'daemon-down',
      detail: 'no daemon',
    });
  });

  it('stops looking, and says why, when the host cannot be asked', async () => {
    // Otherwise the setup step says it is looking for a server forever, with
    // nothing offered and nothing to press.
    rpcRemote.probe.mockRejectedValue(new Error('ssh: connection refused'));
    const store = new RemoteServerStore();

    await store.probe('vm-1');

    expect(store.isProbing('vm-1')).toBe(false);
    expect(store.probeFor('vm-1')).toMatchObject({ kind: 'unreadable' });
    expect(store.error).toBeNull();
  });

  it('asks nothing of a host that is out of reach', async () => {
    isBlocked.mockReturnValue(true);
    const store = new RemoteServerStore();

    await store.probe('vm-1');

    expect(rpcRemote.probe).not.toHaveBeenCalled();
  });
});

describe('connect', () => {
  it('joins the running server and refreshes the server list and who uses it', async () => {
    rpcRemote.connect.mockResolvedValue({
      kind: 'connected',
      serverId: 'srv-1',
      deployedVersion: '0.27.0',
    });
    const store = new RemoteServerStore();

    await store.connect('vm-1', 'Team server');

    expect(rpcRemote.connect).toHaveBeenCalledWith({ sshHost: 'vm-1', name: 'Team server' });
    expect(rpcRemote.start).not.toHaveBeenCalled();
    expect(serversInit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.registerFor('vm-1')).toEqual(REGISTER));
    expect(store.error).toBeNull();
  });

  it('looks again when the server turned out not to be running, so Start is offered', async () => {
    rpcRemote.connect.mockResolvedValue({ kind: 'not-running' });
    rpcRemote.probe.mockResolvedValue({
      kind: 'present',
      running: false,
      deployedVersion: '0.27.0',
      shared: true,
    });
    const store = new RemoteServerStore();

    await store.connect('vm-1', 'Team server');

    await vi.waitFor(() =>
      expect(store.probeFor('vm-1')).toMatchObject({ kind: 'present', running: false })
    );
    expect(serversInit).not.toHaveBeenCalled();
  });

  it('says why another account’s unshared server cannot be joined', async () => {
    rpcRemote.connect.mockResolvedValue({
      kind: 'unshared',
      ownerDir: null,
      message: 'set up from another account',
    });
    rpcRemote.probe.mockResolvedValue({ kind: 'absent', busy: null });
    const store = new RemoteServerStore();

    await store.connect('vm-1', 'Team server');

    expect(store.error).toBe('set up from another account');
  });

  it('is not busy once it has finished, whatever the outcome', async () => {
    rpcRemote.connect.mockRejectedValue(new Error('ipc closed'));
    const store = new RemoteServerStore();

    expect(await store.connect('vm-1', 'Team server')).toBeNull();

    expect(store.isTransitioning('vm-1')).toBe(false);
    expect(store.error).toBeTruthy();
  });
});

describe('deleting a server for everyone', () => {
  it('resets its stack and then leaves it, forgetting what it knew of the host', async () => {
    // Left on the register, this Console would count as a user for two weeks,
    // holding the others' updates; and a stale register kept here would decide
    // the "for everyone?" question on the next server on this host.
    const store = new RemoteServerStore();
    await store.loadRegister('vm-1');

    expect(await store.deleteForEveryone('vm-1', 'srv-1')).toBe(true);

    expect(rpcRemote.reset).toHaveBeenCalledWith('vm-1');
    expect(rpcRemote.disconnect).toHaveBeenCalledWith('vm-1');
    expect(rpcRemote.reset.mock.invocationCallOrder[0]).toBeLessThan(
      rpcRemote.disconnect.mock.invocationCallOrder[0]!
    );
    expect(forgetRemovedServer).toHaveBeenCalledWith('srv-1');
    expect(agentsLoad).toHaveBeenCalledOnce();
    expect(store.registerFor('vm-1')).toBeNull();
  });

  it('keeps the server when its stack could not be reset', async () => {
    rpcRemote.reset.mockRejectedValueOnce(new Error('host unreachable'));
    const store = new RemoteServerStore();

    expect(await store.deleteForEveryone('vm-1', 'srv-1')).toBe(false);

    expect(rpcRemote.disconnect).not.toHaveBeenCalled();
    expect(forgetRemovedServer).not.toHaveBeenCalled();
    expect(store.error).toMatch(/not deleted/);
  });
});

describe('disconnect', () => {
  it('lets go of the server and forgets what it knew of the host', async () => {
    rpcRemote.probe.mockResolvedValue({ kind: 'absent', busy: null });
    const store = new RemoteServerStore();
    await store.probe('vm-1');
    await store.loadRegister('vm-1');

    expect(await store.disconnect('vm-1', 'srv-1')).toBe(true);

    expect(rpcRemote.disconnect).toHaveBeenCalledWith('vm-1');
    expect(rpcRemote.stop).not.toHaveBeenCalled();
    expect(forgetRemovedServer).toHaveBeenCalledWith('srv-1');
    expect(agentsLoad).toHaveBeenCalledOnce();
    expect(store.probeFor('vm-1')).toBeNull();
    expect(store.registerFor('vm-1')).toBeNull();
  });

  it('reports a failure rather than pretending the server is gone', async () => {
    rpcRemote.disconnect.mockRejectedValue(new Error('An operation is already in progress'));
    const store = new RemoteServerStore();

    expect(await store.disconnect('vm-1', 'srv-1')).toBe(false);

    expect(forgetRemovedServer).not.toHaveBeenCalled();
    expect(store.error).toBeTruthy();
  });
});

describe('loadRegister', () => {
  it('keeps a failed read apart from the page’s error', async () => {
    rpcRemote.register.mockRejectedValue(new Error('docker run failed'));
    const store = new RemoteServerStore();

    await store.loadRegister('vm-1');

    expect(store.registerErrorFor('vm-1')).toBeTruthy();
    expect(store.error).toBeNull();
  });
});

describe('waiting for another Console', () => {
  const bob = {
    name: 'bob@desk',
    hostAccount: 'bob',
    action: 'starting' as const,
    heldForSeconds: 40,
    expiresInSeconds: 80,
  };

  it('counts as busy while the main process waits on someone else’s lock', async () => {
    rpcRemote.getStatuses.mockResolvedValue([]);
    const store = new RemoteServerStore();
    const first = statusListeners.length;
    await store.init();
    // Statuses first, then log lines.
    const onStatus = statusListeners[first]!;

    onStatus({ ...store.statusFor('vm-1'), phase: 'stopped', waitingFor: bob });

    expect(store.isTransitioning('vm-1')).toBe(true);
    onStatus({ ...store.statusFor('vm-1'), waitingFor: null });
    expect(store.isTransitioning('vm-1')).toBe(false);
  });

  it('asks the main process to stop waiting', async () => {
    rpcRemote.cancelWait.mockResolvedValue(undefined);
    const store = new RemoteServerStore();

    await store.cancelWait('vm-1');

    expect(rpcRemote.cancelWait).toHaveBeenCalledWith('vm-1');
    expect(store.error).toBeNull();
  });

  it('says so when it could not ask', async () => {
    rpcRemote.cancelWait.mockRejectedValue(new Error('ipc closed'));
    const store = new RemoteServerStore();

    await store.cancelWait('vm-1');

    expect(store.error).toBe('Could not stop waiting for the server.');
  });

  it('treats a start whose wait was cancelled as nothing having happened', async () => {
    rpcRemote.start.mockResolvedValue({ kind: 'cancelled' });
    const store = new RemoteServerStore();

    await store.start('vm-1', 'Team server');

    expect(store.error).toBeNull();
    expect(serversInit).not.toHaveBeenCalled();
    expect(store.isTransitioning('vm-1')).toBe(false);
  });

  it('shows what the host has again after a join whose wait was cancelled', async () => {
    rpcRemote.connect.mockResolvedValue({ kind: 'cancelled' });
    rpcRemote.probe.mockResolvedValue({ kind: 'absent', busy: bob });
    const store = new RemoteServerStore();

    await store.connect('vm-1', 'Team server');

    expect(store.error).toBeNull();
    await vi.waitFor(() => expect(store.probeFor('vm-1')).toEqual({ kind: 'absent', busy: bob }));
  });
});

describe('the paths the rest leave', () => {
  it('records Docker being unavailable when joining finds it so', async () => {
    rpcRemote.connect.mockResolvedValue({
      kind: 'docker-unavailable',
      reason: 'daemon-down',
      detail: 'Docker is not running on vm-1.',
    });
    rpcRemote.probe.mockResolvedValue({ kind: 'absent', busy: null });
    const store = new RemoteServerStore();

    await store.connect('vm-1', 'Team server');

    expect(store.dockerFor('vm-1')).toEqual({
      available: false,
      reason: 'daemon-down',
      detail: 'Docker is not running on vm-1.',
    });
    expect(store.error).toBe('Docker is not running on vm-1.');
  });

  it('reads who uses a server again after starting or stopping it', async () => {
    rpcRemote.start.mockResolvedValue({
      kind: 'started',
      serverId: 'srv-1',
      telemetryEnabled: false,
      warning: null,
    });
    rpcRemote.stop.mockResolvedValue(undefined);
    const store = new RemoteServerStore();

    await store.start('vm-1', 'Team server');
    await store.stop('vm-1');

    expect(rpcRemote.register).toHaveBeenCalledTimes(2);
    expect(store.registerFor('vm-1')).toEqual(REGISTER);
  });

  it('asks nothing of a host that is out of reach for who uses it', async () => {
    isBlocked.mockReturnValue(true);
    const store = new RemoteServerStore();

    await store.loadRegister('vm-1');

    expect(rpcRemote.register).not.toHaveBeenCalled();
    expect(store.registerErrorFor('vm-1')).toBeNull();
  });
});

describe('looking again at a stopped server', () => {
  it('asks the main process to look', async () => {
    rpcRemote.refresh.mockResolvedValue(undefined);

    await new RemoteServerStore().refresh('vm-1');

    expect(rpcRemote.refresh).toHaveBeenCalledWith('vm-1');
  });

  it('asks nothing of a host that is out of reach', async () => {
    isBlocked.mockReturnValue(true);

    await new RemoteServerStore().refresh('vm-1');

    expect(rpcRemote.refresh).not.toHaveBeenCalled();
  });

  it('says so when it could not ask', async () => {
    rpcRemote.refresh.mockRejectedValue(new Error('ipc closed'));
    const store = new RemoteServerStore();

    await store.refresh('vm-1');

    expect(store.error).toBe('Could not check the server again.');
  });
});

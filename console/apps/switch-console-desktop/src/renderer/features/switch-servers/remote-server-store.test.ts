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
}));
const agentsLoad = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const serversInit = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const forgetRemovedServer = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const isBlocked = vi.hoisted(() => vi.fn(() => false));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { remoteSwitchServer: rpcRemote },
  events: { on: () => () => {} },
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
    rpcRemote.probe.mockResolvedValue({ kind: 'absent' });
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

describe('disconnect', () => {
  it('lets go of the server and forgets what it knew of the host', async () => {
    rpcRemote.probe.mockResolvedValue({ kind: 'absent' });
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

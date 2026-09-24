import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteServerStatus } from '@shared/events/remoteSwitchServerEvents';
import type { StackOnHost } from './stack-state';
import type * as StackState from './stack-state';

/**
 * The remote supervisor's side of shared stacks (CHOO-2893): joining one,
 * leaving one without touching it, and keeping its view of one that other
 * Consoles can stop, restart or reset — taken from the host each time rather
 * than remembered.
 */

const requireReachable = vi.hoisted(() => vi.fn());
const isBlocked = vi.hoisted(() => vi.fn(() => false));
const onReachability = vi.hoisted(() => vi.fn());
const createRemoteServerHost = vi.hoisted(() => vi.fn());
const inspectStack = vi.hoisted(() => vi.fn<() => Promise<StackOnHost>>());
const connectStack = vi.hoisted(() => vi.fn());
const adoptRunningStack = vi.hoisted(() => vi.fn());
const listManagedServers = vi.hoisted(() => vi.fn());
const getRemoteManagedServer = vi.hoisted(() => vi.fn());
const ensureManagedServer = vi.hoisted(() => vi.fn());
const removeServer = vi.hoisted(() => vi.fn());
const forgetObservedAgentsForServer = vi.hoisted(() => vi.fn(async () => [] as string[]));
const clearSecrets = vi.hoisted(() => vi.fn());
const clearPorts = vi.hoisted(() => vi.fn());
const readVersionStatus = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ deployedVersion: '0.11.0', drift: null }))
);
const readDeployedTelemetry = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ known: true, enabled: false }))
);
const emitted = vi.hoisted(() => [] as RemoteServerStatus[]);
const writeRecord = vi.hoisted(() =>
  vi.fn((_host: unknown, _action: unknown) => Promise.resolve())
);
const readRegister = vi.hoisted(() => vi.fn());

vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: { requireReachable, isBlocked, on: onReachability },
}));
vi.mock('./host/remote-host', () => ({ createRemoteServerHost }));
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  inspectStack,
}));
vi.mock('./pipeline', () => ({
  connectStack,
  adoptRunningStack,
  startStack: vi.fn(),
  stopStack: vi.fn(),
  resetStack: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  listManagedServers,
  getRemoteManagedServer,
  ensureManagedServer,
  removeServer,
}));
vi.mock('@main/core/switch-servers/delete-server-agents', () => ({
  deleteAgentsForServer: vi.fn(),
  forgetObservedAgentsForServer,
}));
vi.mock('@main/core/telemetry/managed-server', () => ({
  reportManagedServerOutcome: vi.fn(),
  reportManagedServerStart: vi.fn(),
  reportManagedServerStartThrew: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({
  events: { emit: (_channel: unknown, status: RemoteServerStatus) => emitted.push(status) },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./paths', () => ({ remoteServerStateDir: (slug: string) => `/user-data/remote/${slug}` }));
vi.mock('./secrets', () => ({ clearSecrets }));
vi.mock('./ports', () => ({ clearPorts }));
vi.mock('./deployed-version', () => ({ readVersionStatus }));
vi.mock('./telemetry-consent', () => ({ readDeployedTelemetry }));
vi.mock('./console-register', () => ({ writeRecord, readRegister }));

const ports = { gateway: 41000, api: 41001, mattermost: 41002, postgres: 41003 };
const secrets = {
  dbPassword: 'owner-pw',
  dbRuntimePassword: 'runtime-pw',
  agentRegistrationToken: 'agent-token',
  jwtSecretKey: 'jwt',
  gatewayAdminPassword: 'admin-pw',
  mattermostAdminPassword: 'mm-admin',
  mattermostUserPassword: 'mm-user',
};

function present(running: boolean): StackOnHost {
  return {
    kind: 'present',
    env: { ports, secrets, version: '0.11.0' },
    raw: 'PUBLISHED\n',
    source: 'published',
    running,
    published: true,
  };
}

function fakeHost() {
  return {
    label: 'vm-1',
    detectDocker: vi.fn(() => Promise.resolve({ available: true, version: '27.0.0' })),
    establishNetworking: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

const RECORD = {
  id: 'srv-1',
  name: 'Team server',
  gatewayUrl: 'http://localhost:41000',
  apiUrl: 'http://localhost:41001',
  managed: true,
  managementKind: 'remote',
  sshHost: 'vm-1',
};

/** The service is a module singleton; each case gets a fresh one. */
async function loadService() {
  vi.resetModules();
  return (await import('./remote-server-service')).remoteServerService;
}

beforeEach(() => {
  vi.clearAllMocks();
  emitted.length = 0;
  isBlocked.mockReturnValue(false);
  listManagedServers.mockResolvedValue([RECORD]);
  getRemoteManagedServer.mockResolvedValue(RECORD);
  adoptRunningStack.mockResolvedValue({ secrets, ports });
});

describe('connect', () => {
  it('keeps the host — it owns the forward — and reports the stack running', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({
      kind: 'connected',
      serverId: 'srv-1',
      deployedVersion: '0.11.0',
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toMatchObject({ kind: 'connected' });

    expect(host.dispose).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'running',
      serverId: 'srv-1',
      deployedVersion: '0.11.0',
      deployedTelemetry: { known: true, enabled: false },
      error: null,
    });
    expect(connectStack).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { kind: 'remote', sshHost: 'vm-1' },
        serverName: 'Team server',
      })
    );
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, 'connected');
  });

  it('leaves a stopped stack stopped, for Start, and lets the host go', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'not-running' });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({ kind: 'not-running' });
    expect(service.getStatus('vm-1').phase).toBe('stopped');
    expect(host.dispose).toHaveBeenCalledOnce();
    // Nothing happened on the host, so there is nothing to record there.
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('shows why another account’s unshared stack cannot be joined', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'unshared', ownerDir: null, message: 'not shared' });
    const service = await loadService();

    await service.connect('vm-1', 'Team server');

    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'error', error: 'not shared' });
  });

  it('reports a failure to reach the host as an error, not a throw', async () => {
    createRemoteServerHost.mockRejectedValue(new Error('ssh: connection refused'));
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'error',
      message: 'ssh: connection refused',
    });
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'ssh: connection refused',
    });
  });
});

describe('disconnect', () => {
  it('drops this Console’s hold on the stack and touches nothing on the host', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    createRemoteServerHost.mockClear();

    writeRecord.mockClear();

    await service.disconnect('vm-1');

    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, 'disconnected');
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(createRemoteServerHost).not.toHaveBeenCalled();
    expect(removeServer).toHaveBeenCalledExactlyOnceWith('srv-1');
    // Agents it only observed there are views of the server, and go with it.
    expect(forgetObservedAgentsForServer).toHaveBeenCalledExactlyOnceWith('srv-1');
    expect(clearSecrets).toHaveBeenCalledWith({ secretsKey: 'remote-switch-server:vm-1:secrets' });
    expect(clearPorts).toHaveBeenCalledWith({ stateDir: '/user-data/remote/vm-1' });
    expect(service.getStatuses()).toEqual([]);
    // The renderer is told the stack is no longer this Console's to show.
    expect(emitted.at(-1)).toMatchObject({ sshHost: 'vm-1', phase: 'stopped', serverId: null });
  });

  it('refuses while another operation on the host is running', async () => {
    let finishConnect: (value: unknown) => void = () => {};
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockReturnValue(new Promise((resolve) => (finishConnect = resolve)));
    const service = await loadService();
    const connecting = service.connect('vm-1', 'Team server');
    await vi.waitFor(() => expect(connectStack).toHaveBeenCalled());

    await expect(service.disconnect('vm-1')).rejects.toThrow(/already in progress/);

    finishConnect({ kind: 'not-running' });
    await connecting;
  });
});

describe('a record that cannot be written', () => {
  it('lets the operation stand, and says on the server page what others will not see', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    writeRecord.mockRejectedValueOnce(new Error('docker run on vm-1 failed: no space left'));
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toMatchObject({ kind: 'connected' });

    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'running',
      recordWarning:
        'This Console could not record on vm-1 that it connected to it, so others using the ' +
        'server will not see that in its activity: docker run on vm-1 failed: no space left',
    });
  });

  it('clears the warning once a record gets through', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    writeRecord.mockRejectedValueOnce(new Error('volume busy'));
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    expect(service.getStatus('vm-1').recordWarning).toMatch(/volume busy/);

    // Launch picks the stack back up and records the sighting.
    inspectStack.mockResolvedValue(present(true));
    await service.initialize();

    expect(service.getStatus('vm-1').recordWarning).toBeNull();
  });

  it('does not stop a disconnect, which has nowhere left to show it', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    writeRecord.mockRejectedValueOnce(new Error('volume busy'));

    await expect(service.disconnect('vm-1')).resolves.toBeUndefined();
    expect(removeServer).toHaveBeenCalledOnce();
  });
});

describe('disconnecting from a host that is out of reach', () => {
  it('still lets go, without waiting on the host to record it', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    writeRecord.mockClear();
    isBlocked.mockReturnValue(true);

    await service.disconnect('vm-1');

    expect(writeRecord).not.toHaveBeenCalled();
    expect(removeServer).toHaveBeenCalledOnce();
  });
});

describe('picking a shared stack back up', () => {
  it('adopts a running stack with the settings the host holds', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();

    await service.initialize();

    expect(adoptRunningStack).toHaveBeenCalledWith(host, present(true));
    expect(host.establishNetworking).toHaveBeenCalledWith(ports);
    expect(host.dispose).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'running', notice: null });
    expect(ensureManagedServer).not.toHaveBeenCalled();
    // Seen, which refreshes the register, but nothing was done to the stack.
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, null);
  });

  it('follows a stack another Console restarted on different ports', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    getRemoteManagedServer.mockResolvedValue({
      ...RECORD,
      gatewayUrl: 'http://localhost:3300',
      apiUrl: 'http://localhost:8000',
    });
    const service = await loadService();

    await service.initialize();

    expect(ensureManagedServer).toHaveBeenCalledWith(
      {
        name: 'Team server',
        gatewayUrl: 'http://localhost:41000',
        apiUrl: 'http://localhost:41001',
      },
      { kind: 'remote', sshHost: 'vm-1' }
    );
  });

  it('shows a stopped stack as stopped, with nothing to explain when this Console did not see it run', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    inspectStack.mockResolvedValue(present(false));
    const service = await loadService();

    await service.initialize();

    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'stopped', notice: null });
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('does not stop the launch when the host cannot be read', async () => {
    createRemoteServerHost.mockRejectedValue(new Error('timed out'));
    const service = await loadService();

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.getStatus('vm-1').phase).toBe('stopped');
  });
});

describe('recheck', () => {
  async function runningService() {
    const first = fakeHost();
    createRemoteServerHost.mockResolvedValue(first);
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();
    await service.initialize();
    return { service, first };
  }

  it('says so when another Console stopped the stack this one was using', async () => {
    const { service, first } = await runningService();
    const second = fakeHost();
    createRemoteServerHost.mockResolvedValue(second);
    inspectStack.mockResolvedValue(present(false));

    service.recheck('vm-1');

    await vi.waitFor(() => expect(service.getStatus('vm-1').phase).toBe('stopped'));
    expect(service.getStatus('vm-1').notice).toMatch(/stopped outside this Console/);
    // The old forward pointed at a stack that is gone.
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('says so when another Console reset the stack away', async () => {
    const { service } = await runningService();
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue({ kind: 'absent' });

    service.recheck('vm-1');

    await vi.waitFor(() =>
      expect(service.getStatus('vm-1').notice).toMatch(/Nothing is set up on vm-1 any more/)
    );
    expect(service.getStatus('vm-1').phase).toBe('stopped');
  });

  it('keeps the forward it holds when the stack is still where it was', async () => {
    const { service, first } = await runningService();
    const second = fakeHost();
    createRemoteServerHost.mockResolvedValue(second);

    service.recheck('vm-1');

    await vi.waitFor(() => expect(second.dispose).toHaveBeenCalledOnce());
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.establishNetworking).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'running', notice: null });
  });

  it.each([
    [
      'cannot be reached',
      () => createRemoteServerHost.mockRejectedValue(new Error('ssh: timed out')),
    ],
    [
      'cannot say what it has',
      () => {
        createRemoteServerHost.mockResolvedValue(fakeHost());
        inspectStack.mockResolvedValue({ kind: 'unreadable', reason: 'docker ps failed' });
      },
    ],
  ])('keeps a running stack running, and its forward, when the host %s', async (_, arrange) => {
    // A failure to ask says nothing about the stack; dropping the forward on
    // one would strand a server that is still up, for good.
    const { service, first } = await runningService();
    arrange();

    service.recheck('vm-1');

    await vi.waitFor(() => expect(service.getStatus('vm-1').notice).toMatch(/Could not check/));
    expect(service.getStatus('vm-1').phase).toBe('running');
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it('looks at most once per interval, however many calls fail', async () => {
    const { service } = await runningService();
    createRemoteServerHost.mockClear();

    service.recheck('vm-1');
    service.recheck('vm-1');
    service.recheck('vm-1');

    await vi.waitFor(() => expect(createRemoteServerHost).toHaveBeenCalledOnce());
  });

  it('leaves alone a stack this Console does not think is running', async () => {
    const service = await loadService();

    service.recheck('vm-1');

    expect(createRemoteServerHost).not.toHaveBeenCalled();
  });

  it('leaves a blocked host to the reachability manager', async () => {
    const { service } = await runningService();
    createRemoteServerHost.mockClear();
    isBlocked.mockReturnValue(true);

    service.recheck('vm-1');

    expect(createRemoteServerHost).not.toHaveBeenCalled();
  });
});

describe('a host coming back while an operation starts', () => {
  it('does not read the host beside the operation, nor give back its flag', async () => {
    // Launch finds the stack stopped, so there is no forward and a recovered
    // host is picked back up.
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(false));
    const service = await loadService();
    await service.initialize();
    const [, onChange] = onReachability.mock.calls[0] as [
      string,
      (change: { current: { status: string; sshHost: string } }) => void,
    ];
    inspectStack.mockClear();

    // The host comes back; the pick-up is waiting on the server list...
    let listed!: () => void;
    listManagedServers.mockImplementationOnce(
      () => new Promise((resolve) => (listed = () => resolve([RECORD])))
    );
    onChange({ current: { status: 'reachable', sshHost: 'vm-1' } });

    // ...when the user clicks Connect, which holds the host until it is done.
    let joined!: () => void;
    connectStack.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          joined = () => resolve({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
        })
    );
    const connecting = service.connect('vm-1', 'Team server');
    await vi.waitFor(() => expect(connectStack).toHaveBeenCalledOnce());

    listed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inspectStack).not.toHaveBeenCalled();
    // The flag is still Connect's: a second operation is refused.
    expect(await service.connect('vm-1', 'Team server')).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/already in progress/),
    });

    joined();
    expect(await connecting).toMatchObject({ kind: 'connected' });
  });
});

describe('probe', () => {
  it('tells the renderer what the host has, without a secret in it', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();

    const probe = await service.probe('vm-1');

    expect(probe).toEqual({
      kind: 'present',
      running: true,
      deployedVersion: '0.11.0',
      shared: true,
    });
    expect(JSON.stringify(probe)).not.toContain('admin-pw');
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('reports Docker being unavailable before looking for a stack', async () => {
    const host = fakeHost();
    host.detectDocker.mockResolvedValue({
      available: false,
      reason: 'daemon-down',
      detail: 'no daemon',
    } as never);
    createRemoteServerHost.mockResolvedValue(host);
    const service = await loadService();

    expect(await service.probe('vm-1')).toEqual({
      kind: 'docker-unavailable',
      reason: 'daemon-down',
      detail: 'no daemon',
    });
    expect(inspectStack).not.toHaveBeenCalled();
  });
});

describe('register', () => {
  it('reads through the live host when this Console holds one', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'connected', serverId: 'srv-1', deployedVersion: null });
    readRegister.mockResolvedValue({ self: 'me', consoles: [], activity: [] });
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    createRemoteServerHost.mockClear();

    expect(await service.register('vm-1')).toEqual({ self: 'me', consoles: [], activity: [] });
    expect(readRegister).toHaveBeenCalledWith(host);
    expect(createRemoteServerHost).not.toHaveBeenCalled();
  });

  it('opens and closes a host of its own otherwise', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    readRegister.mockResolvedValue({ self: 'me', consoles: [], activity: [] });
    const service = await loadService();

    await service.register('vm-1');

    expect(readRegister).toHaveBeenCalledWith(host);
    expect(host.dispose).toHaveBeenCalledOnce();
  });
});

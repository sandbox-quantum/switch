import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type { RemoteServerStatus } from '@shared/events/remoteSwitchServerEvents';
import type * as DeployedVersion from './deployed-version';
import type * as ManagedUpgrade from './managed-upgrade';
import type * as StackLock from './stack-lock';
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
const startStack = vi.hoisted(() => vi.fn());
const stopStack = vi.hoisted(() => vi.fn(async () => {}));
const resetStack = vi.hoisted(() => vi.fn(async () => {}));
const deleteAgentsForServer = vi.hoisted(() => vi.fn(async () => ({ failed: [] })));
const adoptRunningStack = vi.hoisted(() => vi.fn());
const listManagedServers = vi.hoisted(() => vi.fn());
const getRemoteManagedServer = vi.hoisted(() => vi.fn());
const ensureManagedServer = vi.hoisted(() => vi.fn());
const removeServer = vi.hoisted(() => vi.fn());
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
const stateVolumeExists = vi.hoisted(() => vi.fn(async () => true));
const readUpgradeJournal = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));

vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: { requireReachable, isBlocked, on: onReachability },
}));
vi.mock('./host/remote-host', () => ({ createRemoteServerHost }));
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  inspectStack,
  stateVolumeExists,
}));
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('./pipeline', () => ({
  bringWorkingDirInStep: async (
    host: { writeFile: (...args: unknown[]) => Promise<void> },
    stack: { source: string; raw: string }
  ) => {
    if (stack.source === 'published') await host.writeFile('.env', stack.raw, 0o600);
  },
  connectStack,
  adoptRunningStack,
  startStack,
  stopStack,
  resetStack,
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  listManagedServers,
  getRemoteManagedServer,
  ensureManagedServer,
  removeServer,
}));
vi.mock('@main/core/switch-servers/delete-server-agents', () => ({ deleteAgentsForServer }));
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
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readVersionStatus,
}));
vi.mock('./telemetry-consent', () => ({ readDeployedTelemetry }));
vi.mock('./console-register', () => ({
  writeRecord,
  readRegister,
  hostAccount: async () => 'me',
}));

/** The server lock (CHOO-2893): taken and given back in order, or — per test —
 * held by someone else. The real module's errors and constants are kept. */
const lockEvents = vi.hoisted(() => [] as string[]);
const acquireServerLock = vi.hoisted(() =>
  vi.fn(async (_host: unknown, claim: { action: string }, _opts: unknown) => {
    lockEvents.push(`take ${claim.action}`);
    return {
      token: 'lease-token',
      lost: false,
      assertHeld: vi.fn(async () => {}),
      release: vi.fn(async () => {
        lockEvents.push(`release ${claim.action}`);
      }),
    };
  })
);
const readServerLock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./stack-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof StackLock>()),
  acquireServerLock,
  readServerLock,
}));
vi.mock('@main/core/switch-servers/console-identity', () => ({
  getConsoleIdentity: async () => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'me@laptop',
  }),
}));

vi.mock('./managed-upgrade', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedUpgrade>()),
  readUpgradeJournal,
}));

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
    runningVersion: null,
  };
}

function fakeHost() {
  return {
    label: 'vm-1',
    detectDocker: vi.fn(() => Promise.resolve({ available: true, version: '27.0.0' })),
    establishNetworking: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn((_name: string, _content: string, _mode?: number) => Promise.resolve()),
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

/** Launch the service and wait out the reconciles it starts in the background. */
async function boot(service: {
  initialize(): Promise<void>;
  ensureReady(sshHost: string, serverName: string): Promise<void>;
}) {
  await service.initialize();
  await service.ensureReady('vm-1', 'Team server');
}

/** The service is a module singleton; each case gets a fresh one. */
async function loadService() {
  vi.resetModules();
  return (await import('./remote-server-service')).remoteServerService;
}

beforeEach(() => {
  vi.clearAllMocks();
  emitted.length = 0;
  lockEvents.length = 0;
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

  it('joins an older stack by updating it, since this Console cannot use it as it is', async () => {
    const joining = fakeHost();
    const starting = fakeHost();
    createRemoteServerHost.mockResolvedValueOnce(joining).mockResolvedValueOnce(starting);
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue({
      kind: 'started',
      serverId: 'srv-1',
      telemetryEnabled: false,
      warning: null,
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'connected',
      serverId: 'srv-1',
      deployedVersion: '0.11.0',
    });

    // The update is a start from the stack's own settings, made the active
    // server the way a Connect click does.
    expect(startStack).toHaveBeenCalledWith(
      expect.objectContaining({ host: starting, serverName: 'Team server', activate: true })
    );
    expect(joining.dispose).toHaveBeenCalledOnce();
    expect(starting.dispose).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'running', serverId: 'srv-1' });
    // What others see is what happened: the stack was started again.
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(starting, 'started');
  });

  it('reports an update that failed while joining as the reason it could not join', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue({
      kind: 'error',
      message: 'The server did not become healthy in time.',
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'error',
      message: 'The server did not become healthy in time.',
    });
    expect(service.getStatus('vm-1').phase).toBe('error');
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
    expect(clearSecrets).toHaveBeenCalledWith({ secretsKey: 'remote-switch-server:vm-1:secrets' });
    expect(clearPorts).toHaveBeenCalledWith({ stateDir: '/user-data/remote/vm-1' });
    expect(service.getStatuses()).toEqual([]);
    // The renderer is told the stack is no longer this Console's to show.
    expect(emitted.at(-1)).toMatchObject({ sshHost: 'vm-1', phase: 'stopped', serverId: null });
  });

  it('leaves the register of a stopped server too, through a host of its own', async () => {
    // Left listed, this Console would count as a user for two weeks — holding
    // the others' updates and named in their prompts.
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    getRemoteManagedServer.mockResolvedValue(RECORD);
    const service = await loadService();

    await service.disconnect('vm-1');

    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, 'disconnected');
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(removeServer).toHaveBeenCalledExactlyOnceWith('srv-1');
  });

  it('does not wait on a slow host to leave, and closes the host it opened late', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      let opened: (value: unknown) => void = () => {};
      createRemoteServerHost.mockReturnValue(new Promise((resolve) => (opened = resolve)));
      getRemoteManagedServer.mockResolvedValue(RECORD);
      const service = await loadService();

      const leaving = service.disconnect('vm-1');
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(leaving).resolves.toBeUndefined();
      expect(removeServer).toHaveBeenCalledOnce();

      opened(host);
      await vi.runAllTimersAsync();
      expect(host.dispose).toHaveBeenCalledOnce();
      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates no register just to leave one where the stack never had any', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    getRemoteManagedServer.mockResolvedValue(RECORD);
    stateVolumeExists.mockResolvedValueOnce(false);
    const service = await loadService();

    await service.disconnect('vm-1');

    expect(writeRecord).not.toHaveBeenCalled();
    expect(removeServer).toHaveBeenCalledOnce();
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
    await boot(service);

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

    await boot(service);

    expect(adoptRunningStack).toHaveBeenCalledWith(host, present(true), expect.anything());
    // Read under the lock, and the lock given back once the read is done.
    expect(lockEvents).toEqual(['take checking', 'release checking']);
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

    await boot(service);

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

    await boot(service);

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

describe('recording that this Console still uses the stack', () => {
  it('records it when picking the stack up, but not again at every re-check', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();

    await boot(service);
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(expect.anything(), null);

    // Requests fail; the stack is looked at again, and is still there.
    service.recheck('vm-1');
    await vi.waitFor(() => expect(inspectStack).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.getStatus('vm-1').phase).toBe('running'));

    expect(writeRecord).toHaveBeenCalledOnce();
  });

  it('records it again once a day has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      createRemoteServerHost.mockResolvedValue(fakeHost());
      inspectStack.mockResolvedValue(present(true));
      const service = await loadService();
      await boot(service);

      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      service.recheck('vm-1');

      await vi.waitFor(() => expect(writeRecord).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recheck', () => {
  async function runningService() {
    const first = fakeHost();
    createRemoteServerHost.mockResolvedValue(first);
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();
    await boot(service);
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
    await boot(service);
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

describe('a stopped stack another account updated', () => {
  it('reads its version from the published settings, not this account’s stale copy', async () => {
    const host = fakeHost();
    const order: string[] = [];
    host.writeFile.mockImplementation(async (name: string) => void order.push(`write ${name}`));
    readVersionStatus.mockImplementation(async () => {
      order.push('version');
      return { deployedVersion: '0.11.0', drift: null };
    });
    createRemoteServerHost.mockResolvedValue(host);
    inspectStack.mockResolvedValue(present(false));
    const service = await loadService();

    await boot(service);

    expect(host.writeFile).toHaveBeenCalledWith('.env', 'PUBLISHED\n', 0o600);
    expect(order.indexOf('write .env')).toBeLessThan(order.indexOf('version'));
  });
});

describe('connecting after the stack was brought up to date elsewhere', () => {
  it('drops the update this Console last saw owed', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    // At launch the stack was stopped and behind the pin.
    inspectStack.mockResolvedValue(present(false));
    readVersionStatus.mockResolvedValueOnce({
      deployedVersion: '0.10.0',
      drift: { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' },
    } as never);
    const service = await loadService();
    await service.initialize();
    await expect(service.ensureReady('vm-1', 'Team server')).rejects.toThrow(/stopped/);

    // Someone else started it at the pin; this Console joins it.
    connectStack.mockResolvedValue({
      kind: 'connected',
      serverId: 'srv-1',
      deployedVersion: '0.11.0',
    });
    expect(await service.connect('vm-1', 'Team server')).toMatchObject({ kind: 'connected' });

    expect(service.getStatus('vm-1').upgrade).toBeNull();
    await expect(service.ensureReady('vm-1', 'Team server')).resolves.toBeUndefined();
  });
});

describe('a start that could not do everything', () => {
  it('says on the server page what it left open', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    startStack.mockResolvedValue({
      kind: 'started',
      serverId: 'srv-1',
      telemetryEnabled: false,
      warning: 'Started, but its shared settings could not be stamped.',
    });
    const service = await loadService();

    expect(await service.start('vm-1', 'Team server')).toMatchObject({ kind: 'started' });
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'running',
      notice: 'Started, but its shared settings could not be stamped.',
    });
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
      drift: null,
      busy: null,
    });
    // A look, which takes no lock.
    expect(acquireServerLock).not.toHaveBeenCalled();
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

describe('stopping and resetting a shared stack', () => {
  it('stops it, says so on the host, and lets the forward go', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    const service = await loadService();

    await service.stop('vm-1');

    expect(stopStack).toHaveBeenCalledWith(host, expect.objectContaining({ token: 'lease-token' }));
    expect(lockEvents).toEqual(['take stopping', 'release stopping']);
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, 'stopped');
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'stopped',
      error: null,
      notice: null,
    });
  });

  it('turns an update held for others into one owed at the next start once stopped', async () => {
    // A stopped stack reaches nobody, so the next start updates it without asking.
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    readVersionStatus.mockResolvedValueOnce({
      deployedVersion: '0.10.0',
      drift: { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' },
    } as never);
    readRegister.mockResolvedValue({
      self: 'me',
      consoles: [
        {
          consoleId: 'bob',
          name: 'bob@desk',
          hostAccount: 'bob',
          appVersion: '0.37.0',
          lastSeenAt: new Date().toISOString(),
        },
      ],
      activity: [],
    });
    const service = await loadService();
    await service.initialize();
    await expect(service.ensureReady('vm-1', 'Team server')).rejects.toThrow(/Others use it too/);

    await service.stop('vm-1');

    expect(service.getStatus('vm-1').upgrade).toEqual({
      state: 'pending',
      from: '0.10.0',
      to: '0.11.0',
    });
  });

  it('reports a stop that failed, and gives the forward back', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    stopStack.mockRejectedValueOnce(new Error('compose down failed'));
    const service = await loadService();

    await expect(service.stop('vm-1')).rejects.toThrow(/compose down failed/);

    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'compose down failed',
    });
    expect(writeRecord).not.toHaveBeenCalled();
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('resets it, deleting its agents first and keeping who did it on the host', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    const service = await loadService();

    await service.reset('vm-1');

    expect(deleteAgentsForServer).toHaveBeenCalledWith('srv-1');
    expect(deleteAgentsForServer.mock.invocationCallOrder[0]).toBeLessThan(
      resetStack.mock.invocationCallOrder[0]!
    );
    expect(writeRecord).toHaveBeenCalledExactlyOnceWith(host, 'reset');
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'stopped',
      deployedVersion: null,
      drift: null,
      upgrade: null,
    });
  });

  it('refuses either while another operation on the host is running', async () => {
    let finish: (value: unknown) => void = () => {};
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const service = await loadService();
    const connecting = service.connect('vm-1', 'Team server');
    await vi.waitFor(() => expect(connectStack).toHaveBeenCalled());

    await expect(service.stop('vm-1')).rejects.toThrow(/already in progress/);
    await expect(service.reset('vm-1')).rejects.toThrow(/already in progress/);

    finish({ kind: 'not-running' });
    await connecting;
  });
});

describe('connecting when it cannot', () => {
  it('reports Docker being unavailable on the host', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({
      kind: 'docker-unavailable',
      reason: 'daemon-down',
      detail: 'Cannot connect to the Docker daemon',
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toMatchObject({
      kind: 'docker-unavailable',
    });
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'Cannot connect to the Docker daemon',
    });
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('reports an update on joining that would be a downgrade, in words', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue({
      kind: 'version-downgrade',
      deployed: '0.12.0',
      expected: '0.11.0',
    });
    const service = await loadService();

    const result = await service.connect('vm-1', 'Team server');

    expect(result).toMatchObject({ kind: 'error' });
    expect(result.kind === 'error' && result.message).toMatch(/0\.12\.0/);
  });

  it('passes on Docker being unavailable for the update on joining', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue({
      kind: 'docker-unavailable',
      reason: 'not-installed',
      detail: 'docker: command not found',
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'docker-unavailable',
      reason: 'not-installed',
      detail: 'docker: command not found',
    });
  });

  it('reports a history copy that failed during the update on joining, in words', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue({
      kind: 'matrix-migration-failed',
      deployed: '0.10.0',
      expected: '0.11.0',
      detail: 'backfill exited 1',
    });
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toMatchObject({ kind: 'error' });
  });
});

describe('connecting through a failure it did not expect', () => {
  it('reports the failure and lets the host go', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockRejectedValue(new Error('ssh: connection reset'));
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'error',
      message: 'ssh: connection reset',
    });
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'ssh: connection reset',
    });
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it('passes the steps of a join on to the page as they happen', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockImplementation(async (opts: { onMessage: (message: string) => void }) => {
      opts.onMessage('Waiting for the server to answer…');
      return { kind: 'connected', serverId: 'srv-1', deployedVersion: '0.11.0' };
    });
    const service = await loadService();

    await service.connect('vm-1', 'Team server');

    expect(emitted.some((status) => status.message === 'Waiting for the server to answer…')).toBe(
      true
    );
  });
});

describe('leaving a server this Console has no record of', () => {
  it('still lets go of the host and forgets its credentials', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    getRemoteManagedServer.mockResolvedValue(undefined);
    const service = await loadService();

    await service.disconnect('vm-1');

    expect(removeServer).not.toHaveBeenCalled();
    expect(clearSecrets).toHaveBeenCalledWith({ secretsKey: 'remote-switch-server:vm-1:secrets' });
  });
});

describe('what a launch says about a stack it cannot take up', () => {
  it('names another account’s unshared stack', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue({
      kind: 'unshared',
      ownerDir: '/home/alice/.switchdash',
      running: true,
    });
    const service = await loadService();

    await boot(service);

    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'stopped' });
    expect(service.getStatus('vm-1').notice).toMatch(
      /another account \(from \/home\/alice\/\.switchdash\)/
    );
  });

  it('names what a partial stack is missing', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue({
      kind: 'incomplete',
      source: 'published',
      missing: ['JWT_SECRET_KEY'],
      raw: '',
      running: false,
    });
    const service = await loadService();

    await boot(service);

    expect(service.getStatus('vm-1').notice).toMatch(/missing JWT_SECRET_KEY/);
  });

  it('still reports a stopped stack when this account’s copy of its settings cannot be refreshed', async () => {
    const host = fakeHost();
    host.writeFile.mockRejectedValue(new Error('read-only file system'));
    createRemoteServerHost.mockResolvedValue(host);
    inspectStack.mockResolvedValue(present(false));
    const service = await loadService();

    await boot(service);

    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'stopped',
      deployedVersion: '0.11.0',
    });
  });

  it('says on the page when the record that it still uses the server cannot be written', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    writeRecord.mockRejectedValueOnce(new Error('volume busy'));
    const service = await loadService();

    await boot(service);

    expect(service.getStatus('vm-1').recordWarning).toBe(
      'Could not record on vm-1 that this Console uses the server, so others may not see it ' +
        'among its users: volume busy'
    );
  });
});

describe('re-checking while something else is running', () => {
  it('leaves the host alone until that operation is done', async () => {
    let finish: (value: unknown) => void = () => {};
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockReturnValueOnce(
      Promise.resolve({ kind: 'connected', serverId: 'srv-1', deployedVersion: '0.11.0' })
    );
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    startStack.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const restarting = service.start('vm-1', 'Team server');
    inspectStack.mockClear();

    service.recheck('vm-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inspectStack).not.toHaveBeenCalled();
    finish({ kind: 'started', serverId: 'srv-1', telemetryEnabled: false, warning: null });
    await restarting;
  });
});

describe('the server lock', () => {
  const bob = {
    name: 'bob@desk',
    hostAccount: 'bob',
    action: 'starting' as const,
    heldForSeconds: 40,
    expiresInSeconds: 80,
  };
  const started = { kind: 'started', serverId: 'srv-1', telemetryEnabled: false, warning: null };
  const connected = { kind: 'connected', serverId: 'srv-1', deployedVersion: '0.11.0' };

  type WaitOptions = { signal: AbortSignal; onWaiting: (holder: typeof bob) => void };

  /** Held by bob until the wait is cancelled. */
  function heldUntilCancelled() {
    acquireServerLock.mockImplementationOnce(async (_host, _claim, opts) => {
      const { signal, onWaiting } = opts as WaitOptions;
      onWaiting(bob);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      // The module the service loaded, whose class it checks for.
      const { ServerLockWaitCancelled } = await import('./stack-lock');
      throw new ServerLockWaitCancelled(bob);
    });
  }

  /** Held by bob until the returned function is called, then taken. */
  function heldUntilFreed(): () => void {
    const take = acquireServerLock.getMockImplementation()!;
    let free = () => {};
    acquireServerLock.mockImplementationOnce(async (host, claim, opts) => {
      (opts as WaitOptions).onWaiting(bob);
      await new Promise<void>((resolve) => (free = resolve));
      return take(host, claim, opts);
    });
    return () => free();
  }

  /** Built from the module the service loaded — so call it after loadService —
   * since the service checks for that module's class. */
  async function busyError() {
    const { ServerBusyError } =
      await import('@shared/core/managed-switch-server/managed-switch-server');
    return new ServerBusyError(bob, 'vm-1');
  }

  it('waits for someone else’s start, saying who for, and only then looks at the host', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    startStack.mockResolvedValue(started);
    const free = heldUntilFreed();
    const service = await loadService();

    const starting = service.start('vm-1', 'Team server');
    await vi.waitFor(() => expect(service.getStatus('vm-1').waitingFor).toEqual(bob));

    expect(service.getStatus('vm-1').message).toBe(
      'Waiting for bob@desk (as bob) to finish starting the server…'
    );
    expect(startStack).not.toHaveBeenCalled();

    free();
    expect(await starting).toMatchObject({ kind: 'started' });
    expect(startStack).toHaveBeenCalledWith(
      expect.objectContaining({ lease: expect.objectContaining({ token: 'lease-token' }) })
    );
    expect(service.getStatus('vm-1').waitingFor).toBeNull();
    expect(lockEvents).toEqual(['take starting', 'release starting']);
  });

  it('stops waiting when cancelled, leaving the server and its forward as they were', async () => {
    const live = fakeHost();
    const restarting = fakeHost();
    createRemoteServerHost.mockResolvedValueOnce(live).mockResolvedValueOnce(restarting);
    connectStack.mockResolvedValue(connected);
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    heldUntilCancelled();

    const start = service.start('vm-1', 'Team server');
    await vi.waitFor(() => expect(service.getStatus('vm-1').waitingFor).toEqual(bob));
    service.cancelWait('vm-1');

    expect(await start).toEqual({ kind: 'cancelled' });
    expect(startStack).not.toHaveBeenCalled();
    expect(live.dispose).not.toHaveBeenCalled();
    expect(restarting.dispose).toHaveBeenCalledOnce();
    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'running',
      waitingFor: null,
      message: null,
      error: null,
    });
  });

  it('gives the lock back before letting the host go when a start fails', async () => {
    const host = fakeHost();
    host.dispose.mockImplementation(() => void lockEvents.push('dispose'));
    createRemoteServerHost.mockResolvedValue(host);
    startStack.mockResolvedValue({ kind: 'error', message: 'compose up failed' });
    const service = await loadService();

    await service.start('vm-1', 'Team server');

    expect(lockEvents).toEqual(['take starting', 'release starting', 'dispose']);
  });

  it('gives the lock back when a start throws', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    startStack.mockRejectedValueOnce(new Error('ssh dropped'));
    const service = await loadService();

    expect(await service.start('vm-1', 'Team server')).toMatchObject({ kind: 'error' });

    expect(lockEvents).toEqual(['take starting', 'release starting']);
  });

  it('joins under the lock, and gives it back before letting the host go', async () => {
    const host = fakeHost();
    host.dispose.mockImplementation(() => void lockEvents.push('dispose'));
    createRemoteServerHost.mockResolvedValue(host);
    connectStack.mockResolvedValue({ kind: 'not-running' });
    const service = await loadService();

    await service.connect('vm-1', 'Team server');

    expect(connectStack).toHaveBeenCalledWith(
      expect.objectContaining({ lease: expect.objectContaining({ token: 'lease-token' }) })
    );
    expect(lockEvents).toEqual(['take connecting', 'release connecting', 'dispose']);
  });

  it('tells the others it is updating when joining an older server updates it', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockResolvedValue({ kind: 'behind', deployed: '0.10.0', expected: '0.11.0' });
    startStack.mockResolvedValue(started);
    const service = await loadService();

    await service.connect('vm-1', 'Team server');

    expect(lockEvents).toEqual([
      'take connecting',
      'release connecting',
      'take updating',
      'release updating',
    ]);
  });

  it('ends a join that was waiting when cancelled, having changed nothing', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    heldUntilCancelled();
    const service = await loadService();

    const joining = service.connect('vm-1', 'Team server');
    await vi.waitFor(() => expect(service.getStatus('vm-1').waitingFor).toEqual(bob));
    service.cancelWait('vm-1');

    expect(await joining).toEqual({ kind: 'cancelled' });
    expect(connectStack).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'stopped', waitingFor: null });
  });

  it('refuses a stop while someone else changes the server, touching nothing and keeping the forward', async () => {
    const live = fakeHost();
    createRemoteServerHost.mockResolvedValue(live);
    connectStack.mockResolvedValue(connected);
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    acquireServerLock.mockRejectedValueOnce(await busyError());

    await expect(service.stop('vm-1')).rejects.toThrow(
      /^bob@desk \(as bob\) is starting the server on vm-1 right now, so nothing was changed\./
    );

    expect(stopStack).not.toHaveBeenCalled();
    expect(live.dispose).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'running', error: null });
    expect(writeRecord).not.toHaveBeenCalledWith(live, 'stopped');
  });

  it('lets the host go when a refused stop had to open one of its own, and stays as it was', async () => {
    const host = fakeHost();
    createRemoteServerHost.mockResolvedValue(host);
    const service = await loadService();
    acquireServerLock.mockRejectedValueOnce(await busyError());

    await expect(service.stop('vm-1')).rejects.toThrow(/right now/);

    expect(host.dispose).toHaveBeenCalledOnce();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'stopped', error: null });
  });

  it('reports a lock that could not be asked for as a failed stop, and gives the forward back', async () => {
    const live = fakeHost();
    createRemoteServerHost.mockResolvedValue(live);
    connectStack.mockResolvedValue(connected);
    const service = await loadService();
    await service.connect('vm-1', 'Team server');
    acquireServerLock.mockRejectedValueOnce(new Error('docker run on vm-1 failed: no daemon'));

    await expect(service.stop('vm-1')).rejects.toThrow(/no daemon/);

    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'docker run on vm-1 failed: no daemon',
    });
    expect(live.dispose).toHaveBeenCalledOnce();
  });

  it('refuses a reset while someone else changes the server, before deleting any agent', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    const service = await loadService();
    acquireServerLock.mockRejectedValueOnce(await busyError());

    await expect(service.reset('vm-1')).rejects.toThrow(/right now, so nothing was changed/);

    expect(deleteAgentsForServer).not.toHaveBeenCalled();
    expect(resetStack).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({ phase: 'stopped', error: null });
  });

  it('takes the lock for a reset before deleting its agents', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    deleteAgentsForServer.mockImplementationOnce(async () => {
      lockEvents.push('delete agents');
      return { failed: [] };
    });
    const service = await loadService();

    await service.reset('vm-1');

    expect(resetStack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 'lease-token' })
    );
    expect(lockEvents).toEqual(['take resetting', 'delete agents', 'release resetting']);
  });

  it('stops waiting to check the server when cancelled, and says it has not checked it', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    heldUntilCancelled();
    const service = await loadService();
    await service.initialize();
    await vi.waitFor(() => expect(service.getStatus('vm-1').waitingFor).toEqual(bob));

    service.cancelWait('vm-1');
    await service.ensureReady('vm-1', 'Team server');

    expect(inspectStack).not.toHaveBeenCalled();
    expect(service.getStatus('vm-1')).toMatchObject({
      waitingFor: null,
      notice:
        'Stopped waiting for bob@desk (as bob) to finish starting the server, so this Console ' +
        'has not checked it since.',
    });
  });

  it('gives up every wait for the lock when the app quits', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    heldUntilCancelled();
    const service = await loadService();

    const starting = service.start('vm-1', 'Team server');
    await vi.waitFor(() => expect(service.getStatus('vm-1').waitingFor).toEqual(bob));
    service.dispose();

    expect(await starting).toEqual({ kind: 'cancelled' });
  });

  it('tells the setup step who is changing the server right now', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue({ kind: 'absent' });
    readServerLock.mockResolvedValueOnce(bob as never);
    const service = await loadService();

    expect(await service.probe('vm-1')).toEqual({ kind: 'absent', busy: bob });
  });

  it('shows nobody when who holds the lock cannot be read, since starting takes it anyway', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue({ kind: 'absent' });
    readServerLock.mockRejectedValueOnce(new Error('docker run failed'));
    const service = await loadService();

    expect(await service.probe('vm-1')).toEqual({ kind: 'absent', busy: null });
  });
});

describe('the paths the rest leave', () => {
  async function running() {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    inspectStack.mockResolvedValue(present(true));
    const service = await loadService();
    await boot(service);
    return service;
  }

  it('reports a reset that failed, keeping the agents it had not reached yet', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    resetStack.mockRejectedValueOnce(new Error('compose down -v failed'));
    const service = await loadService();

    await expect(service.reset('vm-1')).rejects.toThrow(/compose down -v failed/);

    expect(service.getStatus('vm-1')).toMatchObject({
      phase: 'error',
      error: 'compose down -v failed',
    });
    expect(writeRecord).not.toHaveBeenCalled();
    expect(lockEvents).toEqual(['take resetting', 'release resetting']);
  });

  it('passes a start’s steps, log lines and update on to the page', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    startStack.mockImplementationOnce(async (opts: StartStackOptionsLike) => {
      opts.onMessage('Pulling images…');
      opts.onLog('pulled switch-core');
      opts.onUpgrade({ from: '0.27.0', to: '0.28.0' });
      expect(service.getStatus('vm-1')).toMatchObject({
        message: 'Pulling images…',
        upgrade: { state: 'updating', from: '0.27.0', to: '0.28.0' },
      });
      return { kind: 'started', serverId: 'srv-1', telemetryEnabled: false, warning: null };
    });
    const service = await loadService();

    await service.start('vm-1', 'Team server');

    expect(emitted).toContainEqual({ sshHost: 'vm-1', line: 'pulled switch-core' });
  });

  it('says what a record that failed with something other than an Error said', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    writeRecord.mockRejectedValueOnce('volume is read-only');
    const service = await loadService();

    await service.stop('vm-1');

    expect(service.getStatus('vm-1').recordWarning).toMatch(/: volume is read-only$/);
  });

  it('reports a join that failed with something other than an Error', async () => {
    createRemoteServerHost.mockResolvedValue(fakeHost());
    connectStack.mockRejectedValueOnce('channel closed');
    const service = await loadService();

    expect(await service.connect('vm-1', 'Team server')).toEqual({
      kind: 'error',
      message: 'channel closed',
    });
  });

  it('keeps a running stack, saying why, when a re-check fails with something other than an Error', async () => {
    const service = await running();
    createRemoteServerHost.mockRejectedValueOnce('ssh gone');

    service.recheck('vm-1');

    await vi.waitFor(() =>
      expect(service.getStatus('vm-1').notice).toBe('Could not check the server on vm-1: ssh gone')
    );
    expect(service.getStatus('vm-1').phase).toBe('running');
  });

  it('does not re-check a server this Console has since forgotten', async () => {
    const service = await running();
    createRemoteServerHost.mockClear();
    listManagedServers.mockResolvedValue([]);

    service.recheck('vm-1');
    await vi.waitFor(() => expect(listManagedServers).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createRemoteServerHost).not.toHaveBeenCalled();
  });

  it('survives a re-check that cannot even list the servers', async () => {
    const service = await running();
    listManagedServers.mockRejectedValueOnce(new Error('database is locked'));

    service.recheck('vm-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.getStatus('vm-1').phase).toBe('running');
  });
});

type StartStackOptionsLike = {
  onMessage: (message: string) => void;
  onLog: (line: string) => void;
  onUpgrade: (owed: { from: string; to: string }) => void;
};

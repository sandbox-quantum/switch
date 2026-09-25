import { beforeEach, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type { StartLocalServerResult } from '@shared/core/managed-switch-server/managed-switch-server';
import type * as ManagedUpgrade from './managed-upgrade';
import type { StartStackOptions } from './pipeline';
import type { StackOnHost } from './stack-state';
import type * as StackState from './stack-state';

/**
 * The remote supervisor keeping each host's stack at this build's switch-core
 * pin: upgrading at reconcile, and holding sessions until that has finished.
 * Its side of shared stacks is in remote-server-service.test.ts.
 */

type Change = { current: { sshHost: string; status: string } };
const m = vi.hoisted(() => {
  const listeners: ((change: Change) => void)[] = [];
  const blocked = new Set<string>();
  return {
    listeners,
    blocked,
    reachability: {
      on(_event: string, listener: (change: Change) => void) {
        listeners.push(listener);
      },
      isBlocked: (sshHost: string) => blocked.has(sshHost),
      requireReachable(sshHost: string) {
        if (blocked.has(sshHost)) throw new Error(`${sshHost} is unreachable`);
      },
    },
    servers: vi.fn(),
    inspect: vi.fn<() => Promise<StackOnHost>>(),
    adopt: vi.fn(),
    version: vi.fn(),
    journal: vi.fn(),
    establish: vi.fn(),
    start: vi.fn<(opts: StartStackOptions) => Promise<StartLocalServerResult>>(),
  };
});
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: m.reachability,
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/telemetry/managed-server', () => ({
  reportManagedServerOutcome: vi.fn(),
  reportManagedServerStart: vi.fn(),
  reportManagedServerStartThrew: vi.fn(),
}));
vi.mock('@main/core/switch-servers/delete-server-agents', () => ({
  deleteAgentsForServer: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  listManagedServers: m.servers,
  getRemoteManagedServer: vi.fn(),
  ensureManagedServer: vi.fn(),
  removeServer: vi.fn(),
}));
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  inspectStack: m.inspect,
}));
vi.mock('./console-register', () => ({ writeRecord: vi.fn(), readRegister: vi.fn() }));
vi.mock('./paths', () => ({ remoteServerStateDir: (slug: string) => `/user-data/remote/${slug}` }));
vi.mock('./secrets', () => ({ clearSecrets: vi.fn() }));
vi.mock('./ports', () => ({ clearPorts: vi.fn() }));
vi.mock('./deployed-version', () => ({ readVersionStatus: m.version }));
vi.mock('./telemetry-consent', () => ({ readDeployedTelemetry: vi.fn() }));
vi.mock('./managed-upgrade', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedUpgrade>()),
  readUpgradeJournal: m.journal,
}));
vi.mock('./pipeline', () => ({
  startStack: m.start,
  adoptRunningStack: m.adopt,
  connectStack: vi.fn(),
  stopStack: vi.fn(),
  resetStack: vi.fn(),
}));
vi.mock('./host/remote-host', () => ({
  createRemoteServerHost: async (sshHost: string) => ({
    sshHost,
    label: sshHost,
    establishNetworking: m.establish,
    dispose: vi.fn(),
  }),
}));

const { RemoteServerService } = await import('./remote-server-service');

const behind = {
  deployedVersion: '0.10.0',
  drift: { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' },
};
const inStep = { deployedVersion: '0.11.0', drift: null };
const ports = { gateway: 1, api: 2, mattermost: 3, postgres: 4 };

function present(running: boolean): StackOnHost {
  return {
    kind: 'present',
    env: { ports, secrets: {} as never, version: '0.10.0' },
    raw: 'PUBLISHED\n',
    source: 'published',
    running,
    published: true,
  };
}

function startedOn(serverId: string): StartLocalServerResult {
  return { kind: 'started', serverId, telemetryEnabled: false };
}

/** A start that runs the upgrade the way the pipeline does: announce, then work. */
function upgradingStart(result?: StartLocalServerResult) {
  return async (opts: StartStackOptions) => {
    opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
    return result ?? startedOn(opts.ref.kind === 'remote' ? `srv-${opts.ref.sshHost}` : 'local');
  };
}

function announce(sshHost: string, status: string): void {
  for (const listener of m.listeners) listener({ current: { sshHost, status } });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.listeners.length = 0;
  m.blocked.clear();
  m.servers.mockResolvedValue([
    { id: 'srv-builder', name: 'Builder', managementKind: 'remote', sshHost: 'builder' },
  ]);
  m.inspect.mockResolvedValue(present(true));
  m.adopt.mockResolvedValue({ ports, secrets: {} });
  m.version.mockResolvedValue(behind);
  m.journal.mockResolvedValue(null);
  m.start.mockImplementation(upgradingStart());
});

it('upgrades a running remote stack that is behind at boot, instead of adopting it', async () => {
  const service = new RemoteServerService();
  await service.initialize();
  await service.ensureReady('builder', 'Builder');

  expect(m.start).toHaveBeenCalledOnce();
  expect(m.start).toHaveBeenCalledWith(
    expect.objectContaining({
      ref: { kind: 'remote', sshHost: 'builder' },
      serverName: 'Builder',
      activate: false,
    })
  );
  expect(m.establish).not.toHaveBeenCalled();
  expect(service.getStatus('builder')).toMatchObject({
    phase: 'running',
    serverId: 'srv-builder',
    upgrade: null,
    drift: null,
  });
});

it('holds sessions for the host while its upgrade runs', async () => {
  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementation(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
        finish = resolve;
      })
  );
  const service = new RemoteServerService();
  void service.initialize();
  let ready = false;
  const session = service.ensureReady('builder', 'Builder').then(() => {
    ready = true;
  });

  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());
  expect(service.getStatus('builder').upgrade).toEqual({
    state: 'updating',
    from: '0.10.0',
    to: '0.11.0',
  });
  expect(ready).toBe(false);
  finish(startedOn('srv-builder'));
  await session;
  expect(ready).toBe(true);
});

it('adopts a running stack that is in step without restarting it', async () => {
  m.version.mockResolvedValue(inStep);
  const service = new RemoteServerService();
  await service.initialize();
  await service.ensureReady('builder', 'Builder');

  expect(m.start).not.toHaveBeenCalled();
  expect(m.establish).toHaveBeenCalledOnce();
  expect(service.getStatus('builder')).toMatchObject({
    phase: 'running',
    serverId: 'srv-builder',
    upgrade: null,
  });
});

it('upgrades a stopped stack that is behind at its next start, not before', async () => {
  m.inspect.mockResolvedValue(present(false));
  const service = new RemoteServerService();
  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  await service.initialize();

  await expect(service.ensureReady('builder', 'Builder')).rejects.toThrow(
    /Builder is stopped on switch-core 0\.10\.0/
  );
  expect(m.start).not.toHaveBeenCalled();

  expect(await service.start('builder', 'Builder')).toMatchObject({ kind: 'started' });
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: true }));
  await expect(service.ensureReady('builder', 'Builder')).resolves.toBeUndefined();
  expect(upgraded).toHaveBeenCalledExactlyOnceWith('srv-builder');
});

it('upgrades a host that was unreachable at boot once it comes back, holding sessions meanwhile', async () => {
  m.blocked.add('builder');
  const service = new RemoteServerService();
  await service.initialize();
  await service.ensureReady('builder', 'Builder');
  expect(m.start).not.toHaveBeenCalled();

  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementation(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
        finish = resolve;
      })
  );
  m.blocked.delete('builder');
  announce('builder', 'reachable');
  // Asked straight after the recovery, as a watcher restoring its controller does.
  let ready = false;
  const session = service.ensureReady('builder', 'Builder').then(() => {
    ready = true;
  });

  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  finish(startedOn('srv-builder'));
  await session;
  expect(service.getStatus('builder').upgrade).toBeNull();
});

it('surfaces a failed upgrade with its error and retries when the host is reconciled again', async () => {
  m.start.mockImplementationOnce(
    upgradingStart({ kind: 'error', message: 'The server did not become healthy in time.' })
  );
  const service = new RemoteServerService();
  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  await service.initialize();

  await expect(service.ensureReady('builder', 'Builder')).rejects.toThrow(
    /Updating Builder from switch-core 0\.10\.0 to 0\.11\.0 failed: The server did not become healthy/
  );
  expect(service.getStatus('builder')).toMatchObject({
    phase: 'error',
    upgrade: { state: 'failed', error: 'The server did not become healthy in time.' },
  });

  announce('builder', 'reachable');
  await vi.waitFor(() => expect(m.start).toHaveBeenCalledTimes(2));
  await expect(service.ensureReady('builder', 'Builder')).resolves.toBeUndefined();
  expect(upgraded).toHaveBeenCalledExactlyOnceWith('srv-builder');
});

it('does not hold one host’s sessions behind another host’s upgrade', async () => {
  m.servers.mockResolvedValue([
    { id: 'srv-builder', name: 'Builder', managementKind: 'remote', sshHost: 'builder' },
    { id: 'srv-other', name: 'Other', managementKind: 'remote', sshHost: 'other' },
  ]);
  m.start.mockImplementation(
    (opts) =>
      new Promise(() => {
        opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
      })
  );
  m.version.mockImplementation(async (host: { sshHost: string }) =>
    host.sshHost === 'builder' ? behind : inStep
  );
  const service = new RemoteServerService();
  await service.initialize();

  await expect(service.ensureReady('other', 'Other')).resolves.toBeUndefined();
  expect(service.getStatus('builder').upgrade?.state).toBe('updating');
});

it('refuses sessions when the host cannot be reached for its upgrade, rather than hanging', async () => {
  const service = new RemoteServerService();
  m.inspect.mockImplementation(async () => {
    // The host drops between the probe and the start.
    m.blocked.add('builder');
    return present(true);
  });
  await service.initialize();

  await expect(service.ensureReady('builder', 'Builder')).rejects.toThrow(
    /failed: builder is unreachable/
  );
});

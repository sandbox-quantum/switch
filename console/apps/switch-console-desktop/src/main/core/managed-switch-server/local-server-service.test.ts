import { beforeEach, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type { StartLocalServerResult } from '@shared/core/managed-switch-server/managed-switch-server';
import type * as ManagedUpgrade from './managed-upgrade';
import type { StartStackOptions } from './pipeline';

const m = vi.hoisted(() => ({
  managed: vi.fn(),
  running: vi.fn(),
  version: vi.fn(),
  journal: vi.fn(),
  start: vi.fn<(opts: StartStackOptions) => Promise<StartLocalServerResult>>(),
  stop: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('@main/lib/events', () => ({ events: { emit: m.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/telemetry/managed-server', () => ({
  reportManagedServerOutcome: vi.fn(),
  reportManagedServerStart: vi.fn(),
  reportManagedServerStartThrew: vi.fn(),
}));
vi.mock('@main/core/switch-servers/delete-server-agents', () => ({
  deleteAgentsForServer: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getManagedServer: m.managed }));
vi.mock('./checkout-build', () => ({
  findCoreCheckout: () => null,
  isCheckoutBuildEnabled: vi.fn(),
  setCheckoutBuildEnabled: vi.fn(),
}));
vi.mock('./compose', () => ({ isStackRunning: m.running }));
vi.mock('./deployed-version', () => ({ readVersionStatus: m.version }));
vi.mock('./telemetry-consent', () => ({ readDeployedTelemetry: vi.fn() }));
vi.mock('./managed-upgrade', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedUpgrade>()),
  readUpgradeJournal: m.journal,
}));
vi.mock('./pipeline', () => ({ startStack: m.start, stopStack: m.stop, resetStack: vi.fn() }));
vi.mock('./host/local-host', () => ({
  LocalServerHost: class {
    dispose() {}
  },
}));

const { LocalServerService } = await import('./local-server-service');

/** Boot, and wait out whatever the boot check started. */
async function boot(service: InstanceType<typeof LocalServerService>): Promise<void> {
  await service.initialize();
  await service.ensureReady('Local').catch(() => {});
}

const behind = {
  deployedVersion: '0.10.0',
  drift: { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' },
};
const started: StartLocalServerResult = {
  kind: 'started',
  serverId: 'local',
  telemetryEnabled: false,
};

/** A start that runs the upgrade the way the pipeline does: announce, then work. */
function upgradingStart(result: StartLocalServerResult = started) {
  return async (opts: StartStackOptions) => {
    opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
    return result;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.managed.mockResolvedValue({ id: 'local', name: 'Local' });
  m.running.mockResolvedValue(true);
  m.version.mockResolvedValue(behind);
  m.journal.mockResolvedValue(null);
  m.start.mockImplementation(upgradingStart());
});

it('upgrades a running server that is behind at boot, without switching to it', async () => {
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).toHaveBeenCalledOnce();
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: false }));
  expect(service.getStatus()).toMatchObject({ phase: 'running', upgrade: null, drift: null });
  await expect(service.ensureReady('Local')).resolves.toBeUndefined();
});

it('shows the update while it runs and holds sessions until it has finished', async () => {
  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementation(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
        finish = resolve;
      })
  );
  const service = new LocalServerService();
  void service.initialize();
  let ready = false;
  const session = service.ensureReady('Local').then(() => {
    ready = true;
  });

  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());
  expect(service.getStatus().upgrade).toEqual({ state: 'updating', from: '0.10.0', to: '0.11.0' });
  expect(ready).toBe(false);

  finish(started);
  await session;
  expect(ready).toBe(true);
  expect(service.getStatus().upgrade).toBeNull();
});

it('marks a stopped server that is behind to update at its next start, never earlier', async () => {
  m.running.mockResolvedValue(false);
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  expect(service.getStatus().upgrade).toEqual({ state: 'pending', from: '0.10.0', to: '0.11.0' });
  await expect(service.ensureReady('Local')).rejects.toThrow(
    /Local is stopped on switch-core 0\.10\.0.*Start it/
  );

  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  expect(await service.start()).toEqual(started);
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: true }));
  await expect(service.ensureReady('Local')).resolves.toBeUndefined();
  // Sessions were refused while it was stopped, so they are told it is back.
  expect(upgraded).toHaveBeenCalledExactlyOnceWith('local');
});

it('resumes an interrupted upgrade even when no container survived it', async () => {
  m.running.mockResolvedValue(false);
  m.version.mockResolvedValue({ deployedVersion: '0.11.0', drift: null });
  m.journal.mockResolvedValue({ from: '0.10.0', to: '0.11.0', backup: '/b' });
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).toHaveBeenCalledOnce();
  expect(service.getStatus().upgrade).toBeNull();
});

it('surfaces a failed backup with its error and refuses sessions until a retry succeeds', async () => {
  m.start.mockImplementationOnce(async (opts) => {
    opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
    throw new Error('pg_dumpall failed: No space left on device');
  });
  const service = new LocalServerService();
  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  await boot(service);

  expect(service.getStatus()).toMatchObject({
    phase: 'error',
    upgrade: {
      state: 'failed',
      from: '0.10.0',
      to: '0.11.0',
      error: 'pg_dumpall failed: No space left on device',
    },
  });
  await expect(service.ensureReady('Local')).rejects.toThrow(
    /Updating Local from switch-core 0\.10\.0 to 0\.11\.0 failed: pg_dumpall failed/
  );
  expect(upgraded).not.toHaveBeenCalled();

  await service.start();
  await expect(service.ensureReady('Local')).resolves.toBeUndefined();
  expect(upgraded).toHaveBeenCalledExactlyOnceWith('local');
});

it('records an upgrade that never turned healthy as failed', async () => {
  m.start.mockImplementation(
    upgradingStart({ kind: 'error', message: 'The server did not become healthy in time.' })
  );
  const service = new LocalServerService();
  await boot(service);

  expect(service.getStatus().upgrade).toMatchObject({
    state: 'failed',
    error: 'The server did not become healthy in time.',
  });
});

it('fails loudly on an upgrade journal it cannot read', async () => {
  m.journal.mockRejectedValue(new Error('journal cannot be read'));
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  await expect(service.ensureReady('Local')).rejects.toThrow('journal cannot be read');
});

it('neither upgrades nor holds sessions for a downgrade or an unreadable version', async () => {
  for (const drift of [
    { deployed: '0.12.0', expected: '0.11.0', direction: 'downgrade' },
    { deployed: 'nightly', expected: '0.11.0', direction: 'unknown' },
    { deployed: null, expected: '0.11.0', direction: 'unreadable', reason: 'daemon down' },
  ]) {
    m.version.mockResolvedValue({ deployedVersion: drift.deployed, drift });
    const service = new LocalServerService();
    await boot(service);
    expect(service.getStatus()).toMatchObject({ drift, upgrade: null });
    await expect(service.ensureReady('Local')).resolves.toBeUndefined();
  }
  expect(m.start).not.toHaveBeenCalled();
});

it('does nothing on an installation without a managed server', async () => {
  m.managed.mockResolvedValue(null);
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  expect(m.version).not.toHaveBeenCalled();
  await expect(service.ensureReady('Local')).resolves.toBeUndefined();
});

it('a Start click during the boot upgrade joins it instead of starting twice', async () => {
  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementationOnce(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: '0.10.0', to: '0.11.0' });
        finish = resolve;
      })
  );
  const service = new LocalServerService();
  void service.initialize();
  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());

  const click = service.start();
  finish(started);
  expect(await click).toEqual(started);
  expect(m.start).toHaveBeenCalledOnce();
});

it('keeps an owed upgrade pending across a stop', async () => {
  m.start.mockImplementationOnce(upgradingStart({ kind: 'error', message: 'unhealthy' }));
  const service = new LocalServerService();
  await boot(service);
  await service.stop();

  expect(service.getStatus()).toMatchObject({
    phase: 'stopped',
    upgrade: { state: 'pending', from: '0.10.0', to: '0.11.0' },
  });
});

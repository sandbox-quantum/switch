import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  managed: vi.fn(),
  running: vi.fn(),
  version: vi.fn(),
  pending: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  verify: vi.fn(),
  start: vi.fn(),
  docker: vi.fn(),
  emit: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: m.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
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
vi.mock('./sdk-compatibility', () => ({ verifySdkCompatibility: m.verify }));
vi.mock('./local-upgrade', () => ({
  prepareLocalUpgrade: m.prepare,
  finishLocalUpgrade: m.finish,
  hasPendingLocalUpgrade: m.pending,
}));
vi.mock('./pipeline', () => ({ startStack: m.start, stopStack: m.stop, resetStack: vi.fn() }));
vi.mock('./host/local-host', () => ({
  LocalServerHost: class {
    detectDocker = m.docker;
    dispose() {}
  },
}));
const { LocalServerService } = await import('./local-server-service');
const { COMPATIBLE_SWITCH_VERSION: expected } = await import('@shared/app-identity');

beforeEach(() => {
  vi.resetAllMocks();
  m.managed.mockResolvedValue({ id: 'local', name: 'Local' });
  m.running.mockResolvedValue(true);
  m.version.mockResolvedValue({
    deployedVersion: '0.1.0',
    drift: { deployed: '0.1.0', expected, direction: 'upgrade' },
  });
  m.pending.mockResolvedValue(false);
  m.docker.mockResolvedValue({ available: true, version: '27' });
  m.start.mockResolvedValue({ kind: 'started', serverId: 'local' });
});

it('automatically backs up and upgrades a running old server without selecting it', async () => {
  const service = new LocalServerService();
  await service.initialize();
  expect(m.prepare).toHaveBeenCalledOnce();
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: false }));
  expect(m.verify).toHaveBeenCalledOnce();
  expect(m.finish).toHaveBeenCalledOnce();
  expect(service.getStatus()).toMatchObject({ phase: 'running', upgrade: null, drift: null });
});
it('holds concurrent launches behind the same upgrade and compatibility check', async () => {
  let done!: () => void;
  m.verify.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      })
  );
  const service = new LocalServerService();
  let ready = false;
  const pending = service.ensureReady().then(() => {
    ready = true;
  });
  const second = service.ensureReady();
  await vi.waitFor(() => expect(m.verify).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  expect(service.getStatus().upgrade).toBe('updating');
  done();
  await Promise.all([pending, second]);
  expect(m.start).toHaveBeenCalledOnce();
});
it('leaves a deliberately stopped server stopped until the user starts it', async () => {
  m.running.mockResolvedValue(false);
  const service = new LocalServerService();
  await service.initialize();
  expect(m.start).not.toHaveBeenCalled();
  await expect(service.ensureReady()).rejects.toThrow('needs an update');
  await service.start();
  expect(m.start).toHaveBeenCalledOnce();
});
it('recovers an interrupted upgrade even when no core container survived', async () => {
  m.running.mockResolvedValue(false);
  m.pending.mockResolvedValue(true);
  const service = new LocalServerService();
  await service.initialize();
  expect(m.start).toHaveBeenCalledOnce();
});
it('keeps backup failure visible and never changes the stack', async () => {
  m.prepare.mockRejectedValue(new Error('Disk is full'));
  const service = new LocalServerService();
  await expect(service.ensureReady()).rejects.toThrow('Disk is full');
  expect(m.start).not.toHaveBeenCalled();
  expect(m.finish).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({ phase: 'error', upgrade: 'required' });
});
it('keeps failed compatibility blocked and retries without reinstalling the app', async () => {
  m.verify.mockRejectedValueOnce(new Error('Server API is not compatible'));
  const service = new LocalServerService();
  await expect(service.ensureReady()).rejects.toThrow('not compatible');
  expect(m.finish).not.toHaveBeenCalled();
  await service.start();
  await expect(service.ensureReady()).resolves.toBeUndefined();
});
it('never automatically downgrades or upgrades an unknown running version', async () => {
  for (const direction of ['downgrade', 'unknown', 'unreadable']) {
    m.version.mockResolvedValue({
      deployedVersion: '99.0.0',
      drift: { deployed: '99.0.0', expected, direction },
    });
    const service = new LocalServerService();
    await expect(service.ensureReady()).rejects.toThrow();
  }
  expect(m.start).not.toHaveBeenCalled();
});
it('requires SDK compatibility even when image versions match', async () => {
  m.version.mockResolvedValue({ deployedVersion: expected, drift: null });
  m.verify.mockRejectedValue(new Error('Update this server'));
  const service = new LocalServerService();
  await expect(service.ensureReady()).rejects.toThrow('Update this server');
  expect(m.start).not.toHaveBeenCalled();
});
it('reports how to recover when Docker is unavailable', async () => {
  m.docker.mockResolvedValue({ available: false, reason: 'daemon-down', detail: 'unreachable' });
  const service = new LocalServerService();
  await expect(service.ensureReady()).rejects.toThrow('Open Docker');
  expect(m.prepare).not.toHaveBeenCalled();
});
it('does not create a server on an installation without a managed server', async () => {
  m.managed.mockResolvedValue(null);
  await new LocalServerService().initialize();
  expect(m.start).not.toHaveBeenCalled();
  expect(m.version).not.toHaveBeenCalled();
});

it('notifies recovery only after a successful retry passes compatibility', async () => {
  m.verify.mockRejectedValueOnce(new Error('API unavailable'));
  const service = new LocalServerService();
  const ready = vi.fn();
  service.onReady(ready);
  await service.initialize();
  expect(ready).not.toHaveBeenCalled();
  await service.start();
  expect(ready).toHaveBeenCalledExactlyOnceWith('local');
});

it('a Start click during boot joins the automatic update instead of restarting twice', async () => {
  const service = new LocalServerService();
  const boot = service.initialize();
  const start = service.start();
  await Promise.all([boot, start]);
  expect(m.start).toHaveBeenCalledOnce();
});

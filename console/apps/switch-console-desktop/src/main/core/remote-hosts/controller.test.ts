import { beforeEach, describe, expect, it, vi } from 'vitest';

const recheckSetup = vi.hoisted(() => vi.fn(async () => ({ sshHost: 'box', steps: [] })));
const checkNow = vi.hoisted(() => vi.fn(async () => ({ status: 'reachable' })));
const upsertRemoteHost = vi.hoisted(() =>
  vi.fn(async (host: { sshHost: string; name: string }) => ({ ...host }))
);
const warn = vi.hoisted(() => vi.fn());

vi.mock('./setup/host-setup-service', () => ({
  recheckSetup,
  discardSetupPlan: vi.fn(),
  ensureSetupPlan: vi.fn(),
  installSetupStep: vi.fn(),
  readAllSetupPlans: vi.fn(),
  readSetupPlan: vi.fn(),
  recheckSetupStep: vi.fn(),
  skipSetupStep: vi.fn(),
  updateSetupStep: vi.fn(),
}));
vi.mock('./production-host-reachability', () => ({
  hostReachabilityService: {
    checkNow,
    get: vi.fn(),
    getAll: vi.fn(),
    forget: vi.fn(),
  },
}));
vi.mock('./store', () => ({
  upsertRemoteHost,
  listRemoteHosts: vi.fn(),
  removeRemoteHost: vi.fn(),
}));
vi.mock('./reachability-store', () => ({
  deletePersistedReachability: vi.fn(),
}));
vi.mock('./list-ssh-config-hosts', () => ({ listSshConfigHosts: vi.fn() }));
vi.mock('@main/core/agents/detect-remote', () => ({
  detectSwitchAgentRemote: vi.fn(),
}));
vi.mock('@main/core/dependencies/remote-dependency-manager', () => ({
  evictRemoteDependencyManager: vi.fn(),
  getRemoteDependencyManager: vi.fn(),
  remoteDependencyDescriptor: vi.fn(),
}));
vi.mock('@main/core/switch-setup/remote-switch-setup', () => ({
  getRemoteSwitchSetupService: vi.fn(),
}));
vi.mock('@main/core/telemetry/telemetry-service', () => ({
  trackEvent: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({
  log: { warn, info: vi.fn(), error: vi.fn() },
}));

const { remoteHostsController } = await import('./controller');

/** Flush the microtask queue so the fire-and-forget probe settles. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('onboardHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkNow.mockResolvedValue({ status: 'reachable' } as never);
    recheckSetup.mockResolvedValue({ sshHost: 'box', steps: [] } as never);
  });

  it('starts a dependency check on the newly onboarded host', async () => {
    // The whole point of CHOO-2801: the host page should show real prerequisite
    // state on arrival rather than waiting for someone to press "Re-check".
    await remoteHostsController.onboardHost({
      sshHost: 'box',
      name: 'Box',
      pickedFromSshConfig: true,
    });
    await settle();

    expect(recheckSetup).toHaveBeenCalledWith('box');
  });

  it('does not make onboarding wait for the dependency check', async () => {
    // A probe walks the host over SSH and can take a while; blocking on it would
    // leave the add-host form spinning long after the host is safely stored.
    let release = () => {};
    recheckSetup.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ sshHost: 'box', steps: [] });
      }) as never
    );

    const host = await remoteHostsController.onboardHost({
      sshHost: 'box',
      name: 'Box',
      pickedFromSshConfig: true,
    });

    expect(host).toEqual({ sshHost: 'box', name: 'Box' });
    release();
  });

  it('onboards the host even when the dependency check fails, and logs it', async () => {
    // The host is reachable and stored; a probe that blows up is a degraded
    // check, not a failed onboarding — but it must not vanish silently.
    recheckSetup.mockRejectedValue(new Error('ssh channel closed'));

    const host = await remoteHostsController.onboardHost({
      sshHost: 'box',
      name: 'Box',
      pickedFromSshConfig: false,
    });
    await settle();

    expect(host).toEqual({ sshHost: 'box', name: 'Box' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('onboarding dependency check failed'),
      expect.objectContaining({ sshHost: 'box', error: 'ssh channel closed' })
    );
  });

  it('does not probe a host that could not be reached', async () => {
    checkNow.mockResolvedValue({
      status: 'unreachable',
      lastError: 'no route',
    } as never);

    await expect(
      remoteHostsController.onboardHost({
        sshHost: 'box',
        name: 'Box',
        pickedFromSshConfig: false,
      })
    ).rejects.toThrow(/Cannot reach box/);
    await settle();

    expect(upsertRemoteHost).not.toHaveBeenCalled();
    expect(recheckSetup).not.toHaveBeenCalled();
  });
});

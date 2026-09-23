import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checks that keep this Console out of the working directory of an agent
 * another account runs (CHOO-2893): the helper every host-bound action asks,
 * the workspace resolver every file access comes through, and opening the
 * location.
 */

const getLocationById = vi.hoisted(() => vi.fn());
const getLocationByHostDir = vi.hoisted(() => vi.fn());
const ensureSshConnected = vi.hoisted(() => vi.fn());
const createPluginFs = vi.hoisted(() => vi.fn(() => ({ read: vi.fn() })));
const providerOpen = vi.hoisted(() => vi.fn());

vi.mock('@main/core/locations/store', async () => {
  class ObservedLocationError extends Error {
    constructor(location: { dir: string; observedOwner: string | null }) {
      super(`${location.dir} belongs to ${location.observedOwner ?? 'another account'}`);
      this.name = 'ObservedLocationError';
    }
  }
  return { getLocationById, getLocationByHostDir, ObservedLocationError };
});
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected }));
vi.mock('@main/core/providers/plugin-fs', () => ({ createPluginFs }));
vi.mock('@main/core/providers/remote-plugin-fs', () => ({ createRemotePluginFs: vi.fn() }));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: class {} }));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `ssh:${host}`,
}));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { openLocation: providerOpen },
}));
vi.mock('@main/core/locations/path-utils', () => ({ checkIsValidDirectory: () => true }));

const { isObservedAgent, locationWhereAgentRuns } = await import('./observed-guard');
const { resolveWorkspaceFsFor } = await import('./agent-workspace-fs');
const { openLocation } = await import('@main/core/locations/operations/open-location');
const { ObservedLocationError } = await import('@main/core/locations/store');

const OBSERVED = {
  id: 'loc-observed',
  name: 'reviewer',
  sshHost: 'vm-1',
  dir: '/home/alice/reviewer',
  observed: true,
  observedOwner: 'alice',
};
const OWN = {
  ...OBSERVED,
  id: 'loc-own',
  dir: '/home/bob/proj',
  observed: false,
  observedOwner: null,
};
const AGENT = { id: 'agent-1', locationId: 'loc' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('locationWhereAgentRuns', () => {
  it('hands back the location of an agent this Console runs', async () => {
    getLocationById.mockResolvedValue(OWN);

    await expect(locationWhereAgentRuns(AGENT)).resolves.toEqual(OWN);
    await expect(isObservedAgent(AGENT)).resolves.toBe(false);
  });

  it('refuses, naming the owner, for an agent another account runs', async () => {
    getLocationById.mockResolvedValue(OBSERVED);

    await expect(locationWhereAgentRuns(AGENT)).rejects.toBeInstanceOf(ObservedLocationError);
    await expect(locationWhereAgentRuns(AGENT)).rejects.toThrow(/belongs to alice/);
    await expect(isObservedAgent(AGENT)).resolves.toBe(true);
  });
});

describe('resolveWorkspaceFsFor', () => {
  it('never opens a connection to a directory this Console only observes', async () => {
    getLocationByHostDir.mockResolvedValue(OBSERVED);

    await expect(resolveWorkspaceFsFor('vm-1', '/home/alice/reviewer')).rejects.toBeInstanceOf(
      ObservedLocationError
    );
    expect(ensureSshConnected).not.toHaveBeenCalled();
  });

  it('opens a directory with no location row, as onboarding needs', async () => {
    getLocationByHostDir.mockResolvedValue(undefined);

    const workspace = await resolveWorkspaceFsFor(null, '/work');

    expect(createPluginFs).toHaveBeenCalledWith('/work');
    workspace.close();
  });
});

describe('openLocation', () => {
  it('opens an observed location without creating anything on its host', async () => {
    getLocationById.mockResolvedValue(OBSERVED);

    expect(await openLocation('loc-observed')).toEqual({ success: true, data: undefined });
    expect(providerOpen).not.toHaveBeenCalled();
  });

  it('opens an ordinary location through its provider, as before', async () => {
    getLocationById.mockResolvedValue(OWN);
    providerOpen.mockResolvedValue({ success: true, data: {} });

    expect((await openLocation('loc-own')).success).toBe(true);
    expect(providerOpen).toHaveBeenCalledWith(OWN);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLocalStatus = vi.hoisted(() => vi.fn());
const getRemoteStatus = vi.hoisted(() => vi.fn());
const isHostBlockedMock = vi.hoisted(() => vi.fn(() => false));
const getReachability = vi.hoisted(() => vi.fn());

vi.mock('./local-server-service', () => ({
  localServerService: { getStatus: getLocalStatus },
}));
vi.mock('./remote-server-service', () => ({
  remoteServerService: { getStatus: getRemoteStatus },
}));
vi.mock('@main/core/remote-hosts/production-host-reachability', () => ({
  hostReachabilityService: { isBlocked: isHostBlockedMock, get: getReachability },
}));

const { isManagedServerRunning, managedServerHostBlocked } =
  await import('./managed-server-status');

function reachability(overrides: Record<string, unknown>) {
  return {
    sshHost: 'host-a',
    status: 'reachable',
    lastError: null,
    lastCheckedAt: null,
    lastReachableAt: null,
    consecutiveFailures: 0,
    nextProbeAt: null,
    probing: false,
    ...overrides,
  };
}

function server(overrides: Record<string, unknown>) {
  return {
    id: 'srv',
    name: 'S',
    gatewayUrl: 'http://localhost:3300',
    apiUrl: 'http://localhost:8000',
    managed: true,
    managementKind: 'local',
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as never;
}

describe('isManagedServerRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isHostBlockedMock.mockReturnValue(false);
  });

  it('returns false for an external (non-managed) server without probing any service', () => {
    expect(isManagedServerRunning(server({ managed: false }))).toBe(false);
    expect(getLocalStatus).not.toHaveBeenCalled();
    expect(getRemoteStatus).not.toHaveBeenCalled();
  });

  it('reads the local status for a local-managed server', () => {
    getLocalStatus.mockReturnValue({ phase: 'running' });
    expect(isManagedServerRunning(server({ managementKind: 'local' }))).toBe(true);

    getLocalStatus.mockReturnValue({ phase: 'stopped' });
    expect(isManagedServerRunning(server({ managementKind: 'local' }))).toBe(false);
  });

  it('treats a legacy managed row (null kind) as local', () => {
    getLocalStatus.mockReturnValue({ phase: 'running' });
    expect(isManagedServerRunning(server({ managementKind: null }))).toBe(true);
    expect(getRemoteStatus).not.toHaveBeenCalled();
  });

  it('reads the per-host status for a remote-managed server', () => {
    getRemoteStatus.mockReturnValue({ phase: 'running' });
    expect(isManagedServerRunning(server({ managementKind: 'remote', sshHost: 'host-a' }))).toBe(
      true
    );
    expect(getRemoteStatus).toHaveBeenCalledWith('host-a');

    getRemoteStatus.mockReturnValue({ phase: 'stopped' });
    expect(isManagedServerRunning(server({ managementKind: 'remote', sshHost: 'host-a' }))).toBe(
      false
    );
  });

  it('returns false for a remote-managed server with no ssh host', () => {
    expect(isManagedServerRunning(server({ managementKind: 'remote', sshHost: null }))).toBe(false);
    expect(getRemoteStatus).not.toHaveBeenCalled();
  });

  it('treats non-running phases (starting/stopping/error) as not running', () => {
    for (const phase of ['starting', 'stopping', 'error']) {
      getLocalStatus.mockReturnValue({ phase });
      expect(isManagedServerRunning(server({ managementKind: 'local' }))).toBe(false);
    }
  });

  it('is not running when the remote host is unreachable, however stale the phase says running', () => {
    getRemoteStatus.mockReturnValue({ phase: 'running' });
    isHostBlockedMock.mockReturnValue(true);
    expect(isManagedServerRunning(server({ managementKind: 'remote', sshHost: 'host-a' }))).toBe(
      false
    );
    expect(isHostBlockedMock).toHaveBeenCalledWith('host-a');
  });

  it('runs again as soon as the host is reachable, with no change to the stack phase', () => {
    getRemoteStatus.mockReturnValue({ phase: 'running' });
    isHostBlockedMock.mockReturnValue(true);
    const remote = server({ managementKind: 'remote', sshHost: 'host-a' });
    expect(isManagedServerRunning(remote)).toBe(false);

    isHostBlockedMock.mockReturnValue(false);
    expect(isManagedServerRunning(remote)).toBe(true);
  });

  it('does not consult reachability for a local-managed server', () => {
    getLocalStatus.mockReturnValue({ phase: 'running' });
    expect(isManagedServerRunning(server({ managementKind: 'local' }))).toBe(true);
    expect(isHostBlockedMock).not.toHaveBeenCalled();
  });
});

describe('managedServerHostBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the reachability record for a remote-managed server on a blocked host', () => {
    const blocked = reachability({ status: 'unreachable', lastError: 'Connection lost' });
    getReachability.mockReturnValue(blocked);
    expect(managedServerHostBlocked(server({ managementKind: 'remote', sshHost: 'host-a' }))).toBe(
      blocked
    );
  });

  it('returns null while the host is reachable', () => {
    getReachability.mockReturnValue(reachability({ status: 'reachable' }));
    expect(
      managedServerHostBlocked(server({ managementKind: 'remote', sshHost: 'host-a' }))
    ).toBeNull();
  });

  it('reports a suspended (auth-failed) host as blocked', () => {
    getReachability.mockReturnValue(reachability({ status: 'suspended' }));
    expect(
      managedServerHostBlocked(server({ managementKind: 'remote', sshHost: 'host-a' }))
    ).not.toBeNull();
  });

  it('returns null for local-managed and external servers without reading reachability', () => {
    expect(managedServerHostBlocked(server({ managementKind: 'local' }))).toBeNull();
    expect(managedServerHostBlocked(server({ managed: false }))).toBeNull();
    expect(getReachability).not.toHaveBeenCalled();
  });
});

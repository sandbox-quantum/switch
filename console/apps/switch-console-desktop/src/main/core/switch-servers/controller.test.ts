import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';

const fetchMe = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const isManagedServerRunning = vi.hoisted(() => vi.fn());
const managedServerHostBlocked = vi.hoisted(() => vi.fn((): unknown => null));
const fetchAuthConfig = vi.hoisted(() => vi.fn());
const trackEvent = vi.hoisted(() => vi.fn());
const addServer = vi.hoisted(() => vi.fn());
const passwordLogin = vi.hoisted(() => vi.fn());
const reconcileServerWorkspaces = vi.hoisted(() => vi.fn());
const listWorkspacesForServer = vi.hoisted(() => vi.fn());
const createTenant = vi.hoisted(() => vi.fn());
// Stubbed rather than reimplemented: what the tests below assert is that the
// kind reaches the event, not how a row is read as one.
const serverKindOf = vi.hoisted(() => vi.fn(() => 'remote_managed'));

// Stub the modules the controller imports that would otherwise pull electron /
// ssh / agent side effects at load.
vi.mock('@main/core/agents/agent-defaults', () => ({ suggestAgentDefaults: vi.fn() }));
vi.mock('@main/core/agents/propagate-server-api-url', () => ({ propagateServerApiUrl: vi.fn() }));
vi.mock('@main/core/agents/write-remote-switch-settings', () => ({
  writeRemoteSwitchSettings: vi.fn(),
}));
vi.mock('@main/core/agents/write-switch-settings', () => ({ writeSwitchSettings: vi.fn() }));
vi.mock('@main/core/app/service', () => ({ appService: { openExternal: vi.fn() } }));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: vi.fn() }));
vi.mock('@main/core/locations/location-transport', () => ({ sshConnectionIdForHost: vi.fn() }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent }));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  isManagedServerRunning,
  managedServerHostBlocked,
}));
// Reads this install's own workspace rows, and through them the database client.
vi.mock('@main/core/workspaces/reconcile-workspaces', () => ({
  reconcileServerWorkspaces,
}));
vi.mock('@main/core/workspaces/workspaces-store', () => ({ listWorkspacesForServer }));
// Writes to the app's log file, which a test has no business creating.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./auth', () => ({ oidcLogin: vi.fn(), passwordLogin }));
// Reads this install's own agent rows, and through them the database client.
vi.mock('./backfill-agent-icons', () => ({ backfillAgentIcons: vi.fn() }));
// Reaches the encrypted secrets store, and through it the database client.
vi.mock('./bundled-chat-sign-in', () => ({ bundledChatSignInFor: vi.fn() }));
vi.mock('./gateway-web', () => ({ openAuthenticatedGatewayPage: vi.fn() }));
vi.mock('./gateway-client', () => ({
  fetchMe,
  agentExistsOnServer: vi.fn(),
  fetchAgentDetail: vi.fn(),
  fetchAgentRooms: vi.fn(),
  fetchAgents: vi.fn(),
  fetchAuthConfig,
  createTenant,
  fetchRoomRoles: vi.fn(),
  fetchRooms: vi.fn(),
  registerKnownAgent: vi.fn(),
  GatewayError: class GatewayError extends Error {},
}));
vi.mock('./servers-store', () => ({
  getServer,
  addServer,
  deleteSessionCookie: vi.fn(),
  listServers: vi.fn(),
  removeServer: vi.fn(),
  renameServer: vi.fn(),
  serverKindOf,
  setActiveServerId: vi.fn(),
  updateServer: vi.fn(),
}));

const { switchServersController } = await import('./controller');

const USER = { id: 'u1', name: 'Dev', email: 'dev@example.com', role: 'admin' };

function server(overrides: Record<string, unknown>) {
  return {
    id: 'srv',
    name: 'S',
    gatewayUrl: 'http://localhost:3300',
    apiUrl: 'http://localhost:8000',
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('getConnectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits to disconnected for a managed server that is not running, without probing', async () => {
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'local' }));
    isManagedServerRunning.mockReturnValue(false);

    const status = await switchServersController.getConnectionStatus('srv');

    expect(status).toEqual({ serverId: 'srv', connected: false, user: null });
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('probes a managed server that is running', async () => {
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'local' }));
    isManagedServerRunning.mockReturnValue(true);
    fetchMe.mockResolvedValue(USER);

    const status = await switchServersController.getConnectionStatus('srv');

    expect(status).toEqual({ serverId: 'srv', connected: true, user: USER });
    expect(fetchMe).toHaveBeenCalledOnce();
  });

  it('probes an external (non-managed) server regardless of the running check', async () => {
    getServer.mockResolvedValue(server({ managed: false }));
    fetchMe.mockResolvedValue(USER);

    const status = await switchServersController.getConnectionStatus('srv');

    expect(status).toEqual({ serverId: 'srv', connected: true, user: USER });
    expect(isManagedServerRunning).not.toHaveBeenCalled();
    expect(fetchMe).toHaveBeenCalledOnce();
  });
});

describe('gateway calls on an unreachable host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
  });

  it('refuses getAuthConfig instead of fetching a gateway that cannot answer', async () => {
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'remote', sshHost: 'h' }));
    managedServerHostBlocked.mockReturnValue({ sshHost: 'h', status: 'unreachable' });

    await expect(switchServersController.getAuthConfig('srv')).rejects.toThrow();
    expect(fetchAuthConfig).not.toHaveBeenCalled();
  });

  it('fetches the auth config normally while the host is reachable', async () => {
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'remote', sshHost: 'h' }));
    fetchAuthConfig.mockResolvedValue({ password: true });

    await expect(switchServersController.getAuthConfig('srv')).resolves.toEqual({ password: true });
    expect(fetchAuthConfig).toHaveBeenCalledOnce();
  });
});

describe('an action a server whose host has gone down cannot take', () => {
  const blocked = {
    sshHost: 'h',
    status: 'unreachable',
    lastError: 'no route to host',
    lastCheckedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'remote', sshHost: 'h' }));
    managedServerHostBlocked.mockReturnValue(blocked);
  });

  it('reports the sign-in that never left this machine', async () => {
    await expect(
      switchServersController.passwordLogin({
        serverId: 'srv',
        email: 'dev@example.com',
        password: 'hunter2',
      })
    ).rejects.toBeInstanceOf(HostUnreachableError);

    expect(passwordLogin).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('server_sign_in', {
      auth_method: 'password',
      server_kind: 'remote_managed',
      outcome: 'failure',
      failure_reason: 'unreachable',
    });
  });

  it('still reports a sign-in by its own reason while the host is up', async () => {
    managedServerHostBlocked.mockReturnValue(null);
    passwordLogin.mockResolvedValue({ success: false, error: { kind: 'invalid_credentials' } });

    await switchServersController.passwordLogin({
      serverId: 'srv',
      email: 'dev@example.com',
      password: 'hunter2',
    });

    expect(trackEvent).toHaveBeenCalledWith('server_sign_in', {
      auth_method: 'password',
      server_kind: 'remote_managed',
      outcome: 'failure',
      failure_reason: 'invalid_credentials',
    });
  });
});

/**
 * Signing in is the first moment the gateway will say which workspaces the
 * account belongs to — before it, the server's only workspace is the
 * placeholder its registration created.
 */
describe('reading the account’s workspaces once it is signed in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServer.mockResolvedValue(server({}));
    managedServerHostBlocked.mockReturnValue(null);
  });

  it('matches the workspaces after a sign-in that succeeded', async () => {
    passwordLogin.mockResolvedValue({ success: true, value: { id: 'u1' } });

    await switchServersController.passwordLogin({
      serverId: 'srv',
      email: 'dev@example.com',
      password: 'hunter2',
    });

    expect(reconcileServerWorkspaces).toHaveBeenCalledWith('srv');
  });

  it('does not after one that failed', async () => {
    passwordLogin.mockResolvedValue({ success: false, error: { kind: 'invalid_credentials' } });

    await switchServersController.passwordLogin({
      serverId: 'srv',
      email: 'dev@example.com',
      password: 'hunter2',
    });

    expect(reconcileServerWorkspaces).not.toHaveBeenCalled();
  });

  // The sign-in itself worked; reporting it as a failure would send the user
  // back to a form with nothing left to do.
  it('still reports the sign-in when the workspaces cannot be read', async () => {
    passwordLogin.mockResolvedValue({ success: true, value: { id: 'u1' } });
    reconcileServerWorkspaces.mockRejectedValue(new Error('gateway too old'));

    const result = await switchServersController.passwordLogin({
      serverId: 'srv',
      email: 'dev@example.com',
      password: 'hunter2',
    });

    expect(result.success).toBe(true);
  });
});

function workspaceRow(overrides: Record<string, unknown>) {
  return {
    id: 'ws',
    serverId: 'srv',
    name: 'W',
    tenantId: 'tenant-1',
    slug: 'w',
    role: 'member',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('resolveWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset rather than cleared: an earlier test leaves a rejection standing on
    // it, and `clearAllMocks` forgets the calls but keeps the behaviour.
    reconcileServerWorkspaces.mockReset().mockResolvedValue(undefined);
    getServer.mockResolvedValue(server({}));
    managedServerHostBlocked.mockReturnValue(null);
  });

  it('answers with the memberships the server confirmed', async () => {
    listWorkspacesForServer.mockResolvedValue([
      workspaceRow({ id: 'ws-1', tenantId: 't1' }),
      workspaceRow({ id: 'ws-2', tenantId: 't2' }),
    ]);

    const found = await switchServersController.resolveWorkspaces('srv');

    expect(reconcileServerWorkspaces).toHaveBeenCalledWith('srv');
    expect(found.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
  });

  // The placeholder a registration creates is not a membership, and offering it
  // would scope the window to a workspace the gateway has never heard of.
  it('leaves out the row that was never matched to a tenant', async () => {
    listWorkspacesForServer.mockResolvedValue([
      workspaceRow({ id: 'ws-1', tenantId: null, slug: null, role: null }),
    ]);

    await expect(switchServersController.resolveWorkspaces('srv')).resolves.toEqual([]);
  });

  /**
   * The row is kept locally so its agents are not silently detached, but every
   * call scoped to it is refused. Offering it puts the refusal after the click;
   * worse, left as the only answer it is the one the caller enters without
   * asking.
   */
  it('leaves out a membership the account has been removed from', async () => {
    listWorkspacesForServer.mockResolvedValue([
      workspaceRow({ id: 'ws-1', tenantId: 't1' }),
      workspaceRow({ id: 'ws-gone', tenantId: 't2', role: null }),
    ]);

    const found = await switchServersController.resolveWorkspaces('srv');

    expect(found.map((w) => w.id)).toEqual(['ws-1']);
  });

  // "You belong to nothing" and "nobody could be asked" are different answers,
  // and a caller that received the empty list for both would offer to create a
  // second workspace to someone who already has one.
  it('raises rather than answering empty when the server cannot be asked', async () => {
    reconcileServerWorkspaces.mockRejectedValue(new Error('gateway unreachable'));

    await expect(switchServersController.resolveWorkspaces('srv')).rejects.toThrow(
      'gateway unreachable'
    );
  });
});

describe('createWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcileServerWorkspaces.mockReset().mockResolvedValue(undefined);
    getServer.mockResolvedValue(server({}));
    managedServerHostBlocked.mockReturnValue(null);
  });

  it('returns the local row for the workspace the gateway minted', async () => {
    createTenant.mockResolvedValue({ id: 't9', slug: 'acme', name: 'Acme', role: 'owner' });
    listWorkspacesForServer.mockResolvedValue([
      workspaceRow({ id: 'ws-1', tenantId: 't1' }),
      workspaceRow({ id: 'ws-9', tenantId: 't9', name: 'Acme', role: 'owner' }),
    ]);

    const created = await switchServersController.createWorkspace({
      serverId: 'srv',
      name: 'Acme',
    });

    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'Acme');
    expect(created.id).toBe('ws-9');
  });

  /**
   * The reconcile is what records the workspace, name included — so one that
   * failed has recorded nothing. Answering anyway would hand back whichever row
   * happened to be there, under a name the user did not type, and report a
   * success the install has no trace of.
   */
  it('raises when the reconcile that records the workspace fails', async () => {
    createTenant.mockResolvedValue({ id: 't9', slug: 'acme', name: 'Acme', role: 'owner' });
    reconcileServerWorkspaces.mockRejectedValue(new Error('the gateway stopped answering'));

    await expect(
      switchServersController.createWorkspace({ serverId: 'srv', name: 'Acme' })
    ).rejects.toThrow('the gateway stopped answering');
    expect(listWorkspacesForServer).not.toHaveBeenCalled();
  });

  // The workspace exists on the server either way. Returning something else, or
  // nothing, would leave the app scoped to a workspace that is not the one just
  // made — so it says so instead.
  it('raises when the new workspace did not land locally', async () => {
    createTenant.mockResolvedValue({ id: 't9', slug: 'acme', name: 'Acme', role: 'owner' });
    listWorkspacesForServer.mockResolvedValue([workspaceRow({ id: 'ws-1', tenantId: 't1' })]);

    await expect(
      switchServersController.createWorkspace({ serverId: 'srv', name: 'Acme' })
    ).rejects.toThrow('did not record it');
  });

  it('does not ask a server whose host is down to create anything', async () => {
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'remote', sshHost: 'h' }));
    managedServerHostBlocked.mockReturnValue({ sshHost: 'h', status: 'unreachable' });

    await expect(
      switchServersController.createWorkspace({ serverId: 'srv', name: 'Acme' })
    ).rejects.toThrow();
    expect(createTenant).not.toHaveBeenCalled();
  });
});

describe('adding a server by URL', () => {
  const params = { name: 'S', gatewayUrl: 'http://gateway', apiUrl: 'http://api' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the add that worked', async () => {
    const added = server({ id: 'new' });
    addServer.mockResolvedValue(added);

    await expect(switchServersController.addServer(params)).resolves.toBe(added);
    expect(trackEvent).toHaveBeenCalledExactlyOnceWith('server_added', {
      server_kind: 'external',
      outcome: 'success',
    });
  });

  it('reports the failure when the row itself cannot be written', async () => {
    addServer.mockRejectedValue(new Error('constraint failed'));

    await expect(switchServersController.addServer(params)).rejects.toThrow('constraint failed');
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('server_added', {
      server_kind: 'external',
      outcome: 'failure',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMe = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const isManagedServerRunning = vi.hoisted(() => vi.fn());
const managedServerHostBlocked = vi.hoisted(() => vi.fn((): unknown => null));
const fetchAuthConfig = vi.hoisted(() => vi.fn());

// Stub the modules the controller imports that would otherwise pull electron /
// ssh / agent side effects at load. We only exercise getConnectionStatus.
vi.mock('@main/core/agents/agent-defaults', () => ({ suggestAgentDefaults: vi.fn() }));
vi.mock('@main/core/agents/propagate-server-api-url', () => ({ propagateServerApiUrl: vi.fn() }));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));
vi.mock('@main/core/agents/write-remote-switch-settings', () => ({
  writeRemoteSwitchSettings: vi.fn(),
}));
vi.mock('@main/core/agents/write-switch-settings', () => ({ writeSwitchSettings: vi.fn() }));
vi.mock('@main/core/app/service', () => ({ appService: { openExternal: vi.fn() } }));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: vi.fn() }));
vi.mock('@main/core/locations/location-transport', () => ({ sshConnectionIdForHost: vi.fn() }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  isManagedServerRunning,
  managedServerHostBlocked,
}));
vi.mock('./auth', () => ({ oidcLogin: vi.fn(), passwordLogin: vi.fn() }));
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
  fetchRoomRoles: vi.fn(),
  fetchRooms: vi.fn(),
  registerKnownAgent: vi.fn(),
  GatewayError: class GatewayError extends Error {},
}));
vi.mock('./servers-store', () => ({
  getServer,
  addServer: vi.fn(),
  deleteSessionCookie: vi.fn(),
  getActiveServerId: vi.fn(),
  listServers: vi.fn(),
  removeServer: vi.fn(),
  renameServer: vi.fn(),
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

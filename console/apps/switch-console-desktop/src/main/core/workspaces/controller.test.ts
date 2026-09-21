import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';

const managedServerHostBlocked = vi.hoisted(() => vi.fn((): unknown => null));
const trackEvent = vi.hoisted(() => vi.fn());
const createRoomOnServer = vi.hoisted(() => vi.fn());
const deleteBridge = vi.hoisted(() => vi.fn());
const deleteRoom = vi.hoisted(() => vi.fn());
const fetchBridges = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const getSessionCookie = vi.hoisted(() => vi.fn());
const requireWorkspace = vi.hoisted(() => vi.fn());
const listWorkspacesForServer = vi.hoisted(() => vi.fn(async () => [{ id: 'ws' }]));
const switchTenant = vi.hoisted(() => vi.fn());
// Stubbed rather than reimplemented: what the tests below assert is that the
// kind reaches the event, not how a row is read as one.
const serverKindOf = vi.hoisted(() => vi.fn(() => 'remote_managed'));

// Stub the modules the controller imports that would otherwise pull electron /
// ssh / agent side effects at load.
vi.mock('@main/core/agents/agent-credentials-slot', () => ({ foreignCredentialsOwner: vi.fn() }));
vi.mock('@main/core/agents/agent-workdir-fs', () => ({ resolveWorkdirFsFor: vi.fn() }));
vi.mock('@main/core/agents/known-agent-type', () => ({ knownAgentTypeForProvider: vi.fn() }));
vi.mock('@main/core/agents/register-agent-identity', () => ({ registerAgentIdentity: vi.fn() }));
vi.mock('@main/core/agents/write-remote-switch-settings', () => ({
  writeRemoteSwitchSettings: vi.fn(),
}));
vi.mock('@main/core/agents/write-switch-settings', () => ({
  writeNeutralAgentSettingsFs: vi.fn(),
  writeSwitchSettings: vi.fn(),
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: vi.fn() }));
vi.mock('@main/core/locations/location-transport', () => ({ sshConnectionIdForHost: vi.fn() }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent }));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  isManagedServerRunning: vi.fn(() => true),
  managedServerHostBlocked,
}));
// Writes to the app's log file, which a test has no business creating.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Reads this install's own agent rows, and through them the database client.
vi.mock('@main/core/switch-servers/backfill-agent-icons', () => ({ backfillAgentIcons: vi.fn() }));
vi.mock('@main/core/switch-servers/bridge-home-url', () => ({ withResolvedHomeUrls: vi.fn() }));
vi.mock('@main/core/switch-servers/create-bridge', () => ({ createBridgeOnServer: vi.fn() }));
vi.mock('@main/core/switch-servers/create-room', () => ({ createRoomOnServer }));
vi.mock('@main/core/switch-servers/identities', () => ({
  claimIdentityOnServer: vi.fn(),
  searchDirectoryOnServer: vi.fn(),
}));
vi.mock('@main/core/switch-servers/update-bridge', () => ({ updateBridgeOnServer: vi.fn() }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  addRoomAgents: vi.fn(),
  agentExistsOnServer: vi.fn(),
  createRoomFromTemplate: vi.fn(),
  decodeJwtTenantId: vi.fn(() => null),
  deleteBridge,
  deleteRoom,
  fetchAddressingPolicy: vi.fn(),
  fetchAgentDetail: vi.fn(),
  fetchAgentRooms: vi.fn(),
  fetchAgents: vi.fn(),
  fetchAllExternalUsers: vi.fn(),
  fetchBridges,
  fetchBridgeTypes: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchRoomAgentIds: vi.fn(),
  fetchRoomDetail: vi.fn(),
  fetchRoomGroups: vi.fn(),
  fetchRoomRoles: vi.fn(),
  fetchRooms: vi.fn(),
  fetchTemplateSchema: vi.fn(),
  GatewayError: class GatewayError extends Error {},
  ownsOwnerAddressedAgent: vi.fn(),
  releaseBridgeIdentity: vi.fn(),
  removeRoomAgent: vi.fn(),
  switchTenant,
  updateAddressingPolicy: vi.fn(),
  updateAgentIcon: vi.fn(),
  updateRoom: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer,
  getSessionCookie,
  serverKindOf,
}));
vi.mock('./workspaces-store', () => ({
  getActiveWorkspaceId: vi.fn(),
  listWorkspaces: vi.fn(),
  listWorkspacesForServer,
  requireWorkspace,
  setActiveWorkspaceId: vi.fn(),
}));

const { workspacesController } = await import('./controller');

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

/** The workspace every call below names, on the server the test set up. */
function workspace(tenantId: string | null = null) {
  return { id: 'ws', serverId: 'srv', name: 'S', tenantId, createdAt: '', updatedAt: '' };
}

describe('disconnecting a bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    requireWorkspace.mockResolvedValue(workspace());
    fetchBridges.mockResolvedValue([{ id: 'b1', type: 'slack' }]);
  });

  it('reports a disconnection the gateway carried out', async () => {
    deleteBridge.mockResolvedValue({ kind: 'deleted' });

    await workspacesController.deleteBridge({ workspaceId: 'ws', bridgeId: 'b1' });

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_disconnected', {
        bridge_platform: 'slack',
        outcome: 'success',
      })
    );
  });

  it('reports a refusal as a failure rather than as a disconnection', async () => {
    // Admin-only, and the gateway hands back the refusal instead of throwing
    // it — so the await returns exactly as it does for a bridge that went.
    deleteBridge.mockResolvedValue({ kind: 'forbidden' });

    await workspacesController.deleteBridge({ workspaceId: 'ws', bridgeId: 'b1' });

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_disconnected', {
        bridge_platform: 'slack',
        outcome: 'failure',
      })
    );
  });
});

describe('an action a workspace whose host has gone down cannot take', () => {
  const blocked = {
    sshHost: 'h',
    status: 'unreachable',
    lastError: 'no route to host',
    lastCheckedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getServer.mockResolvedValue(server({ managed: true, managementKind: 'remote', sshHost: 'h' }));
    requireWorkspace.mockResolvedValue(workspace());
    managedServerHostBlocked.mockReturnValue(blocked);
    // What the gateway does on a host that cannot be reached: the platform is
    // then unknowable rather than absent.
    fetchBridges.mockRejectedValue(new Error('no route to host'));
  });

  it('reports the room it refused to create', async () => {
    await expect(
      workspacesController.createRoom({
        workspaceId: 'ws',
        name: 'Room',
        description: '',
        bridgeId: 'b1',
        agentIds: ['a1'],
      })
    ).rejects.toBeInstanceOf(HostUnreachableError);

    expect(createRoomOnServer).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('room_created', {
        server_kind: 'remote_managed',
        bridge_platform: 'unknown',
        agent_count: 1,
        has_instructions: false,
        outcome: 'failure',
        failure_reason: 'unreachable',
      })
    );
  });

  it('reports the room it refused to delete', async () => {
    await expect(
      workspacesController.deleteRoom({ workspaceId: 'ws', roomId: 'r1' })
    ).rejects.toBeInstanceOf(HostUnreachableError);

    expect(deleteRoom).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('room_deleted', {
      server_kind: 'remote_managed',
      outcome: 'failure',
    });
  });
});

/**
 * The seam's whole point: a call names a workspace, and the session it goes out
 * on must be selecting that workspace's tenant. A read that answered from the
 * previously selected tenant would succeed and look right.
 */
describe('selecting the workspace’s tenant before the call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    fetchBridges.mockResolvedValue([]);
  });

  it('switches when the session is selecting another tenant', async () => {
    requireWorkspace.mockResolvedValue(workspace('tenant-b'));
    getSessionCookie.mockResolvedValue('cookie-for-tenant-a');

    await workspacesController.listBridges('ws');

    expect(switchTenant).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'tenant-b');
  });

  it('does not switch when the session already selects it', async () => {
    const { decodeJwtTenantId } = await import('@main/core/switch-servers/gateway-client');
    vi.mocked(decodeJwtTenantId).mockReturnValue('tenant-b');
    requireWorkspace.mockResolvedValue(workspace('tenant-b'));
    getSessionCookie.mockResolvedValue('cookie-for-tenant-b');

    await workspacesController.listBridges('ws');

    expect(switchTenant).not.toHaveBeenCalled();
  });

  it('asserts nothing for a workspace with no tenant, where its server has only the one', async () => {
    requireWorkspace.mockResolvedValue(workspace(null));

    await workspacesController.listBridges('ws');

    expect(switchTenant).not.toHaveBeenCalled();
    expect(getSessionCookie).not.toHaveBeenCalled();
  });

  it('refuses a workspace with no tenant where its server has several', async () => {
    requireWorkspace.mockResolvedValue(workspace(null));
    listWorkspacesForServer.mockResolvedValueOnce([{ id: 'ws' }, { id: 'ws-2' }]);

    await expect(workspacesController.listBridges('ws')).rejects.toThrow('has not been matched');
    expect(fetchBridges).not.toHaveBeenCalled();
  });
});

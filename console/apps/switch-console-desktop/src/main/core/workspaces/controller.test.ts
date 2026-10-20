import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';

const managedServerHostBlocked = vi.hoisted(() => vi.fn((): unknown => null));
const trackEvent = vi.hoisted(() => vi.fn());
const createRoomOnServer = vi.hoisted(() => vi.fn());
const disconnectBridgeOnServer = vi.hoisted(() => vi.fn());
const bridgeInstallState = vi.hoisted(() => vi.fn());
const deleteRoom = vi.hoisted(() => vi.fn());
const fetchBridges = vi.hoisted(() => vi.fn());
const fetchBridgeTeams = vi.hoisted(() => vi.fn());
const addBridgeTeam = vi.hoisted(() => vi.fn());
const removeBridgeTeam = vi.hoisted(() => vi.fn());
const updateBridgeOnServer = vi.hoisted(() => vi.fn());
const saveTeamsPackage = vi.hoisted(() => vi.fn());
const createRoomFromTemplate = vi.hoisted(() => vi.fn());
const runTemplateWithAgents = vi.hoisted(() => vi.fn());
const runTemplateDocument = vi.hoisted(() => vi.fn());
const fetchRoomDetail = vi.hoisted(() => vi.fn());
const fetchManagedAgent = vi.hoisted(() => vi.fn());
const managedAgentLocation = vi.hoisted(() => vi.fn(async () => 'local'));
const getServer = vi.hoisted(() => vi.fn());
const getSessionCookie = vi.hoisted(() => vi.fn());
const requireWorkspace = vi.hoisted(() => vi.fn());
const listWorkspacesForServer = vi.hoisted(() => vi.fn(async () => [{ id: 'ws' }]));
const switchTenant = vi.hoisted(() => vi.fn());
const fetchConnectionAgents = vi.hoisted(() => vi.fn());
const fetchWorkspaceServices = vi.hoisted(() => vi.fn());
const setWorkspaceService = vi.hoisted(() => vi.fn());
const connectServiceWithKey = vi.hoisted(() => vi.fn());
const disconnectService = vi.hoisted(() => vi.fn());
const disconnectGitHub = vi.hoisted(() => vi.fn());
const serviceBrowserFlow = vi.hoisted(() => ({
  startServiceBrowserFlow: vi.fn(),
  getServiceBrowserFlow: vi.fn(),
  cancelServiceBrowserFlow: vi.fn(),
}));
const openExternal = vi.hoisted(() => vi.fn());
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
// The provider registry is built at app startup; what is asserted below is that
// the agent's provider reaches the event, not how an id is validated.
vi.mock('@main/core/telemetry/agent-type', () => ({ agentTypeOf: (id: string) => id }));
vi.mock('@main/core/agent-migration/managed-agent-location', () => ({ managedAgentLocation }));
vi.mock('@main/core/managed-switch-server/managed-server-status', () => ({
  isManagedServerRunning: vi.fn(() => true),
  managedServerHostBlocked,
}));
// Writes to the app's log file, which a test has no business creating.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Reads this install's own agent rows, and through them the database client.
vi.mock('@main/core/app/service', () => ({ appService: { openExternal } }));
vi.mock('@main/core/switch-servers/service-browser-flow', () => serviceBrowserFlow);
vi.mock('@main/core/switch-servers/backfill-agent-icons', () => ({ backfillAgentIcons: vi.fn() }));
vi.mock('@main/core/switch-servers/bridge-home-url', () => ({ withResolvedHomeUrls: vi.fn() }));
vi.mock('@main/core/switch-servers/create-bridge', () => ({ createBridgeOnServer: vi.fn() }));
vi.mock('@main/core/switch-servers/create-room', () => ({ createRoomOnServer }));
vi.mock('@main/core/switch-servers/disconnect-bridge', () => ({
  disconnectBridgeOnServer,
  bridgeInstallState,
}));
vi.mock('@main/core/switch-servers/identities', () => ({
  claimIdentityOnServer: vi.fn(),
  searchDirectoryOnServer: vi.fn(),
}));
vi.mock('@main/core/switch-servers/teams-package', () => ({ saveTeamsPackage }));
vi.mock('@main/core/switch-servers/update-bridge', () => ({ updateBridgeOnServer }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  addBridgeTeam,
  addRoomAgents: vi.fn(),
  agentExistsOnServer: vi.fn(),
  connectServiceWithKey,
  disconnectGitHub,
  disconnectService,
  createRoomFromTemplate,
  decodeJwtTenantId: vi.fn(() => null),
  deleteRoom,
  fetchAddressingPolicy: vi.fn(),
  fetchAgentDetail: vi.fn(),
  fetchAgentRooms: vi.fn(),
  fetchAgents: vi.fn(),
  fetchAllExternalUsers: vi.fn(),
  fetchBridges,
  fetchBridgeTeams,
  fetchBridgeTypes: vi.fn(),
  fetchConnectionAgents,
  fetchWorkspaceServices,
  fetchMyIdentities: vi.fn(),
  fetchRoomAgentIds: vi.fn(),
  fetchManagedAgent,
  fetchRoomDetail,
  fetchRoomGroups: vi.fn(),
  fetchRoomRoles: vi.fn(),
  fetchRooms: vi.fn(),
  fetchTemplateSchema: vi.fn(),
  GatewayError: class GatewayError extends Error {},
  ownsOwnerAddressedAgent: vi.fn(),
  releaseBridgeIdentity: vi.fn(),
  removeBridgeTeam,
  removeRoomAgent: vi.fn(),
  runTemplateDocument,
  runTemplateWithAgents,
  setWorkspaceService,
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
    url: 'http://localhost:8000',
    dashboardUrl: 'http://localhost:3300',
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
    disconnectBridgeOnServer.mockResolvedValue({ kind: 'deleted' });

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
    disconnectBridgeOnServer.mockResolvedValue({ kind: 'forbidden' });

    await workspacesController.deleteBridge({ workspaceId: 'ws', bridgeId: 'b1' });

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_disconnected', {
        bridge_platform: 'slack',
        outcome: 'failure',
      })
    );
  });
});

describe('deleting a room', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    requireWorkspace.mockResolvedValue(workspace());
  });

  it('keeps the platform channel unless asked', async () => {
    deleteRoom.mockResolvedValue(null);

    await expect(
      workspacesController.deleteRoom({ workspaceId: 'ws', roomId: 'r1' })
    ).resolves.toBeNull();

    expect(deleteRoom).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'r1', {
      retireChannel: false,
    });
  });

  it('passes on a request to retire the channel, and what became of it', async () => {
    deleteRoom.mockResolvedValue({ outcome: 'archived', reason: null });

    await expect(
      workspacesController.deleteRoom({ workspaceId: 'ws', roomId: 'r1', retireChannel: true })
    ).resolves.toEqual({ outcome: 'archived', reason: null });

    expect(deleteRoom).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'r1', {
      retireChannel: true,
    });
  });
});

describe('distributed Microsoft Teams team placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    requireWorkspace.mockResolvedValue(workspace());
  });

  it('reads whether a bridge is backed by a live install, scoped to the workspace’s server', async () => {
    bridgeInstallState.mockResolvedValue('installed');

    await expect(
      workspacesController.bridgeInstallState({ workspaceId: 'ws', bridgeId: 'b1' })
    ).resolves.toBe('installed');

    expect(bridgeInstallState).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'b1');
  });

  it('lists a bridge’s team placement', async () => {
    const result = {
      kind: 'listed' as const,
      teams: [],
      defaultTeamId: null,
      inCatalog: true,
      catalogProblem: null,
    };
    fetchBridgeTeams.mockResolvedValue(result);

    await expect(
      workspacesController.listBridgeTeams({ workspaceId: 'ws', bridgeId: 'b1' })
    ).resolves.toEqual(result);

    expect(fetchBridgeTeams).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'b1');
  });

  it('adds Switch to a team', async () => {
    addBridgeTeam.mockResolvedValue({ kind: 'added' });

    await expect(
      workspacesController.addBridgeTeam({ workspaceId: 'ws', bridgeId: 'b1', teamId: 't1' })
    ).resolves.toEqual({ kind: 'added' });

    expect(addBridgeTeam).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'b1', 't1');
  });

  it('removes Switch from a team', async () => {
    removeBridgeTeam.mockResolvedValue({ kind: 'removed' });

    await expect(
      workspacesController.removeBridgeTeam({ workspaceId: 'ws', bridgeId: 'b1', teamId: 't1' })
    ).resolves.toEqual({ kind: 'removed' });

    expect(removeBridgeTeam).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv' }),
      'b1',
      't1'
    );
  });

  it('chooses a default team by editing the bridge, turning channel creation on with it', async () => {
    const updated = { kind: 'updated' as const, bridge: { id: 'b1' } as never };
    updateBridgeOnServer.mockResolvedValue(updated);

    await expect(
      workspacesController.setDefaultTeamsTeam({ workspaceId: 'ws', bridgeId: 'b1', teamId: 't1' })
    ).resolves.toEqual(updated);

    expect(updateBridgeOnServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), {
      bridgeId: 'b1',
      channelCreationEnabled: true,
      connectionConfig: { team_id: 't1' },
    });
  });

  it('saves the Teams app package to disk under the chosen file name', async () => {
    saveTeamsPackage.mockResolvedValue('/tmp/switch-teams.zip');

    await expect(
      workspacesController.downloadTeamsPackage({
        workspaceId: 'ws',
        bridgeId: 'b1',
        defaultFileName: 'switch-teams.zip',
      })
    ).resolves.toBe('/tmp/switch-teams.zip');

    expect(saveTeamsPackage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv' }),
      'b1',
      'switch-teams.zip'
    );
  });

  it('reports a cancelled save as null rather than a path', async () => {
    saveTeamsPackage.mockResolvedValue(null);

    await expect(
      workspacesController.downloadTeamsPackage({
        workspaceId: 'ws',
        bridgeId: 'b1',
        defaultFileName: 'switch-teams.zip',
      })
    ).resolves.toBeNull();
  });
});

describe('reporting what a template made', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    requireWorkspace.mockResolvedValue(workspace());
    fetchRoomDetail.mockImplementation(async (_server: unknown, roomId: string) => ({
      id: roomId,
      agentCount: roomId === 'r1' ? 2 : 0,
      bridgeType: roomId === 'r1' ? 'slack' : null,
      instructions: roomId === 'r1' ? 'Triage incoming bugs.' : null,
    }));
  });

  it('reports each room a template made, as the server holds it', async () => {
    createRoomFromTemplate.mockResolvedValue({
      kind: 'group',
      groupId: 'g1',
      groupName: 'G',
      rooms: [
        { roomId: 'r1', roomName: 'A', failedAttachments: [] },
        { roomId: 'r2', roomName: 'B', failedAttachments: [] },
      ],
      errors: [],
    });

    await workspacesController.createRoomFromTemplate('ws', 'version: 1', {}, 'Triage');

    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(2));
    expect(trackEvent).toHaveBeenCalledWith('room_created', {
      server_kind: 'remote_managed',
      bridge_platform: 'slack',
      agent_count: 2,
      has_instructions: true,
      outcome: 'success',
      failure_reason: 'none',
      source: 'template',
    });
    expect(trackEvent).toHaveBeenCalledWith('room_created', {
      server_kind: 'remote_managed',
      bridge_platform: 'unknown',
      agent_count: 0,
      has_instructions: false,
      outcome: 'success',
      failure_reason: 'none',
      source: 'template',
    });
  });

  it('reports the agents and the room a run made, with where the run started', async () => {
    runTemplateDocument.mockResolvedValue({
      kind: 'created',
      createdAgents: [
        {
          slot: 'buddy',
          agentId: 'a1',
          name: 'buddy',
          machine: { id: 'c1', name: 'laptop' },
          listening: true,
        },
      ],
      room: { kind: 'room', roomId: 'r1', roomName: 'A', failedAttachments: [] },
    });
    fetchManagedAgent.mockResolvedValue({ agentId: 'a1', provider: 'claude', controllerId: 'c1' });

    await workspacesController.runTemplateDocument('ws', {
      template: 'version: 2',
      inputs: {},
      filled: {},
      templateName: 'Buddy',
      entryPoint: 'onboarding',
    });

    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(2));
    expect(managedAgentLocation).toHaveBeenCalledWith('srv', 'c1');
    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'onboarding',
    });
    expect(trackEvent).toHaveBeenCalledWith(
      'room_created',
      expect.objectContaining({ source: 'template', agent_count: 2 })
    );
  });

  it('keeps the entry point out of what is sent to the server', async () => {
    runTemplateWithAgents.mockResolvedValue({ kind: 'created', createdAgents: [], room: null });

    await workspacesController.runTemplateWithAgents('ws', {
      agents: [],
      yamlText: null,
      inputs: {},
      templateName: 'T',
      entryPoint: 'template',
    });

    expect(runTemplateWithAgents).toHaveBeenCalledWith(expect.anything(), {
      agents: [],
      yamlText: null,
      inputs: {},
      templateName: 'T',
    });
  });

  it('reports nothing for a run the server refused, which made nothing', async () => {
    runTemplateDocument.mockResolvedValue({
      kind: 'refused',
      code: 'agents_not_created',
      message: 'No.',
      problems: [],
      leftBehind: [],
    });

    await workspacesController.runTemplateDocument('ws', {
      template: 'version: 2',
      inputs: {},
      filled: {},
      templateName: 'T',
      entryPoint: 'template',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('does not report a room it could not read back with its details guessed', async () => {
    createRoomFromTemplate.mockResolvedValue({
      kind: 'room',
      roomId: 'r1',
      roomName: 'A',
      failedAttachments: [],
    });
    fetchRoomDetail.mockRejectedValue(new Error('no route to host'));

    await workspacesController.createRoomFromTemplate('ws', 'version: 1', {}, 'T');

    await vi.waitFor(() => expect(fetchRoomDetail).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackEvent).not.toHaveBeenCalled();
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
        source: 'dialog',
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

  it('reads and switches the services of the workspace named, not the active one', async () => {
    const { decodeJwtTenantId } = await import('@main/core/switch-servers/gateway-client');
    vi.mocked(decodeJwtTenantId).mockReturnValue('tenant-a');
    requireWorkspace.mockResolvedValue(workspace('tenant-b'));
    getSessionCookie.mockResolvedValue('cookie-for-tenant-a');
    // Each call is only answered once the session selects the named workspace.
    const selected = () => {
      expect(switchTenant).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'tenant-b');
      return Promise.resolve(null);
    };
    fetchConnectionAgents.mockImplementation(selected);
    fetchWorkspaceServices.mockImplementation(selected);
    setWorkspaceService.mockImplementation(selected);

    await workspacesController.getConnectionAgents({ workspaceId: 'ws', service: 'example' });
    await workspacesController.getWorkspaceServices('ws');
    await workspacesController.setWorkspaceService({
      workspaceId: 'ws',
      service: 'example',
      enabled: false,
    });

    expect(fetchConnectionAgents).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv' }),
      'example'
    );
    expect(fetchWorkspaceServices).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }));
    expect(setWorkspaceService).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv' }),
      'example',
      false
    );
  });

  it('connects, signs in and disconnects in the workspace named, not the active one', async () => {
    const { decodeJwtTenantId } = await import('@main/core/switch-servers/gateway-client');
    vi.mocked(decodeJwtTenantId).mockReturnValue('tenant-a');
    requireWorkspace.mockResolvedValue(workspace('tenant-b'));
    getSessionCookie.mockResolvedValue('cookie-for-tenant-a');
    const selected = () => {
      expect(switchTenant).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv' }), 'tenant-b');
      return Promise.resolve(null);
    };
    for (const call of [
      connectServiceWithKey,
      disconnectService,
      disconnectGitHub,
      ...Object.values(serviceBrowserFlow),
    ])
      call.mockImplementation(selected);
    const srv = expect.objectContaining({ id: 'srv' });
    const flow = { workspaceId: 'ws', service: 'example', flowId: 'flow-1' };

    await workspacesController.startServiceConnection({ workspaceId: 'ws', service: 'example' });
    await workspacesController.getServiceFlow(flow);
    await workspacesController.cancelServiceConnection(flow);
    await workspacesController.connectServiceWithKey({
      workspaceId: 'ws',
      service: 'example',
      fields: { api_key: 'synthetic' },
    });
    await workspacesController.disconnectService({ workspaceId: 'ws', service: 'example' });
    await workspacesController.disconnectGitHub('ws');

    expect(serviceBrowserFlow.startServiceBrowserFlow).toHaveBeenCalledWith(
      srv,
      'example',
      expect.any(Function)
    );
    expect(serviceBrowserFlow.getServiceBrowserFlow).toHaveBeenCalledWith(srv, 'example', 'flow-1');
    expect(serviceBrowserFlow.cancelServiceBrowserFlow).toHaveBeenCalledWith(
      srv,
      'example',
      'flow-1'
    );
    expect(connectServiceWithKey).toHaveBeenCalledWith(srv, 'example', { api_key: 'synthetic' });
    expect(disconnectService).toHaveBeenCalledWith(srv, 'example');
    expect(disconnectGitHub).toHaveBeenCalledWith(srv);
  });

  it('refuses a workspace with no tenant where its server has several', async () => {
    requireWorkspace.mockResolvedValue(workspace(null));
    listWorkspacesForServer.mockResolvedValueOnce([{ id: 'ws' }, { id: 'ws-2' }]);

    await expect(workspacesController.listBridges('ws')).rejects.toThrow('has not been matched');
    expect(fetchBridges).not.toHaveBeenCalled();
  });
});

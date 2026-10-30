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
const claimIdentityOnServer = vi.hoisted(() => vi.fn());
const cancelLinkRequestOnServer = vi.hoisted(() => vi.fn());
const fetchMyIdentities = vi.hoisted(() => vi.fn());
const fetchUnconfirmedLinks = vi.hoisted(() => vi.fn());
const requireLinkConfirmationOnServer = vi.hoisted(() => vi.fn());
const managedAgentLocator = vi.hoisted(() =>
  vi.fn(async () => (controllerId: string) => (controllerId === 'c1' ? 'local' : 'remote'))
);
const trackEventAt = vi.hoisted(() =>
  vi.fn((name: string, properties: unknown, _at: number) => trackEvent(name, properties))
);
const canSend = vi.hoisted(() => vi.fn(async () => true));
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
vi.mock('@main/core/telemetry/telemetry-service', () => ({
  trackEvent,
  trackEventAt,
  telemetryService: { canSend },
}));
// The provider registry is built at app startup, which a test does not run.
vi.mock('@main/core/telemetry/agent-type', () => ({ agentTypeOf: (id: string) => id }));
vi.mock('@main/core/agent-migration/managed-agent-location', () => ({ managedAgentLocator }));
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
  cancelLinkRequestOnServer,
  claimIdentityOnServer,
  issueLinkCodeOnServer: vi.fn(),
  requireLinkConfirmationOnServer,
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
  fetchMyIdentities,
  fetchMyPendingIdentities: vi.fn(),
  fetchUnconfirmedLinks,
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

describe('linking a messaging account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedServerHostBlocked.mockReturnValue(null);
    getServer.mockResolvedValue(server({}));
    requireWorkspace.mockResolvedValue(workspace());
    fetchBridges.mockResolvedValue([{ id: 'b1', type: 'slack' }]);
  });

  const PARAMS = { workspaceId: 'ws', bridgeId: 'b1', externalUserId: 'U1', username: 'ada' };

  it('reports a link waiting for its code apart from one that took effect', async () => {
    // A pending link counts for nothing until the code is posted; filing it
    // under success would hide every link that is never confirmed.
    claimIdentityOnServer.mockResolvedValue({ kind: 'pending', pending: {}, code: null });

    await workspacesController.claimBridgeIdentity(PARAMS);

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_claimed', {
        bridge_platform: 'slack',
        outcome: 'pending',
      })
    );
  });

  it('reports a link that took effect at once as a success', async () => {
    claimIdentityOnServer.mockResolvedValue({ kind: 'claimed', identity: {} });

    await workspacesController.claimBridgeIdentity(PARAMS);

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_claimed', {
        bridge_platform: 'slack',
        outcome: 'success',
      })
    );
  });

  it('cancels a waiting confirmation through the request-only route', async () => {
    // The full unlink would also drop a link made before confirming, which
    // works today; Cancel must only ever withdraw the code.
    cancelLinkRequestOnServer.mockResolvedValue({ kind: 'cancelled' });

    await expect(
      workspacesController.cancelIdentityLinkRequest({
        workspaceId: 'ws',
        bridgeId: 'b1',
        identityId: 'eu-1',
      })
    ).resolves.toEqual({ kind: 'cancelled' });

    expect(cancelLinkRequestOnServer).toHaveBeenCalledWith(expect.anything(), 'b1', 'eu-1');
  });

  describe('a confirmation the screen saw', () => {
    const CONFIRMED = { id: 'eu-1', bridgeId: 'b1', bridgeType: 'slack', verified: true };
    const REPORT = { workspaceId: 'ws', bridgeId: 'b1', identityId: 'eu-1', kind: 'pending' };

    it('is reported once the server agrees the link is confirmed', async () => {
      fetchMyIdentities.mockResolvedValue([CONFIRMED]);

      await workspacesController.reportIdentityConfirmed(REPORT);

      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_confirmed', {
        bridge_platform: 'slack',
        link_kind: 'new',
      });
    });

    it('names a link made before confirming as existing', async () => {
      fetchMyIdentities.mockResolvedValue([CONFIRMED]);

      await workspacesController.reportIdentityConfirmed({ ...REPORT, kind: 'unverified' });

      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_confirmed', {
        bridge_platform: 'slack',
        link_kind: 'existing',
      });
    });

    it('reports a kind it does not recognise as unknown rather than passing it on', async () => {
      fetchMyIdentities.mockResolvedValue([CONFIRMED]);

      await workspacesController.reportIdentityConfirmed({ ...REPORT, kind: 'whatever' });

      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_confirmed', {
        bridge_platform: 'slack',
        link_kind: 'unknown',
      });
    });

    it('is not reported when the server does not list the link as confirmed', async () => {
      fetchMyIdentities.mockResolvedValue([{ ...CONFIRMED, verified: false }]);

      await workspacesController.reportIdentityConfirmed(REPORT);

      expect(trackEvent).not.toHaveBeenCalled();
    });

    it('asks the server nothing while sharing is off', async () => {
      canSend.mockResolvedValueOnce(false);

      await workspacesController.reportIdentityConfirmed(REPORT);

      expect(fetchMyIdentities).not.toHaveBeenCalled();
      expect(trackEvent).not.toHaveBeenCalled();
    });

    it('never fails, even when the server cannot be read', async () => {
      fetchMyIdentities.mockRejectedValue(new Error('unreachable'));

      await expect(workspacesController.reportIdentityConfirmed(REPORT)).resolves.toBeUndefined();
      expect(trackEvent).not.toHaveBeenCalled();
    });
  });

  it('lists one app’s older links from its server', async () => {
    const LINKS = [
      { id: 'eu-1', externalUserId: 'U1', externalUsername: 'ada', userId: 'u1', userName: 'Ada' },
    ];
    fetchUnconfirmedLinks.mockResolvedValue(LINKS);

    await expect(
      workspacesController.listUnconfirmedLinks({ workspaceId: 'ws', bridgeId: 'b1' })
    ).resolves.toEqual(LINKS);
    expect(fetchUnconfirmedLinks).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('requires confirming one app’s older links', async () => {
    requireLinkConfirmationOnServer.mockResolvedValue({ kind: 'required', moved: 2 });

    await expect(
      workspacesController.requireLinkConfirmation({ workspaceId: 'ws', bridgeId: 'b1' })
    ).resolves.toEqual({ kind: 'required', moved: 2 });
    expect(requireLinkConfirmationOnServer).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('reports a refused claim as a failure', async () => {
    claimIdentityOnServer.mockResolvedValue({ kind: 'bridge-unavailable', message: 'stopped' });

    await workspacesController.claimBridgeIdentity(PARAMS);

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('bridge_identity_claimed', {
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
  const createdAgent = {
    slot: 'pm',
    agentId: 'a1',
    name: 'pm',
    machine: { id: 'c1', name: 'laptop' },
    listening: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    canSend.mockResolvedValue(true);
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

  it('reports the agents a run made from what the run declared, reading none back', async () => {
    runTemplateWithAgents.mockResolvedValue({
      kind: 'created',
      createdAgents: [createdAgent],
      room: null,
    });

    await workspacesController.runTemplateWithAgents('ws', {
      agents: [{ slot: 'pm', provider: 'codex' } as never],
      yamlText: null,
      inputs: {},
      templateName: 'T',
      entryPoint: 'template',
    });

    await vi.waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('agent_created', {
        agent_type: 'codex',
        location: 'local',
        outcome: 'success',
        failure_reason: 'none',
        entry_point: 'template',
      })
    );
    expect(managedAgentLocator).toHaveBeenCalledWith('srv');
    expect(fetchManagedAgent).not.toHaveBeenCalled();
  });

  it('reads back the provider of an agent a document run chose', async () => {
    runTemplateDocument.mockResolvedValue({
      kind: 'created',
      createdAgents: [createdAgent],
      room: { kind: 'room', roomId: 'r1', roomName: 'A', failedAttachments: [] },
    });
    fetchManagedAgent.mockResolvedValue({ agentId: 'a1', provider: 'claude', controllerId: 'c1' });

    await workspacesController.runTemplateDocument('ws', {
      template: 'version: 2',
      inputs: {},
      filled: {},
      templateName: 'Buddy',
      templateId: null,
      entryPoint: 'onboarding',
    });

    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(2));
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

  it('stamps what a run made with when the run finished, not when the reads came back', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    fetchRoomDetail.mockImplementation(async (_server: unknown, roomId: string) => {
      now.mockReturnValue(9_000);
      return { id: roomId, agentCount: 1, bridgeType: null, instructions: null };
    });
    createRoomFromTemplate.mockResolvedValue({
      kind: 'room',
      roomId: 'r1',
      roomName: 'A',
      failedAttachments: [],
    });

    await workspacesController.createRoomFromTemplate('ws', 'version: 1', {}, 'T');

    await vi.waitFor(() =>
      expect(trackEventAt).toHaveBeenCalledWith('room_created', expect.anything(), 1_000)
    );
    now.mockRestore();
  });

  it('does not switch back to the run’s workspace to describe it', async () => {
    requireWorkspace.mockResolvedValue(workspace('tenant-a'));
    // As when the person has already moved on to another workspace.
    getSessionCookie.mockResolvedValue('cookie-for-another-workspace');
    createRoomFromTemplate.mockResolvedValue({
      kind: 'room',
      roomId: 'r1',
      roomName: 'A',
      failedAttachments: [],
    });

    await workspacesController.createRoomFromTemplate('ws', 'version: 1', {}, 'T');

    await vi.waitFor(() => expect(canSend).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Once, for the run itself; never again for the report.
    expect(switchTenant).toHaveBeenCalledTimes(1);
    expect(fetchRoomDetail).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('asks the server nothing when nothing it read could be sent', async () => {
    canSend.mockResolvedValue(false);
    runTemplateDocument.mockResolvedValue({
      kind: 'created',
      createdAgents: [createdAgent],
      room: { kind: 'room', roomId: 'r1', roomName: 'A', failedAttachments: [] },
    });

    await workspacesController.runTemplateDocument('ws', {
      template: 'version: 2',
      inputs: {},
      filled: {},
      templateName: 'T',
      templateId: null,
      entryPoint: 'template',
    });

    await vi.waitFor(() => expect(canSend).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchRoomDetail).not.toHaveBeenCalled();
    expect(fetchManagedAgent).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
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
      templateId: null,
      entryPoint: 'template',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(canSend).not.toHaveBeenCalled();
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

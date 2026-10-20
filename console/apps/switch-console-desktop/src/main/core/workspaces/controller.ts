import { managedAgentLocation } from '@main/core/agent-migration/managed-agent-location';
import { appService } from '@main/core/app/service';
import { backfillAgentIcons } from '@main/core/switch-servers/backfill-agent-icons';
import { withResolvedHomeUrls } from '@main/core/switch-servers/bridge-home-url';
import { createBridgeOnServer } from '@main/core/switch-servers/create-bridge';
import { createRoomOnServer } from '@main/core/switch-servers/create-room';
import {
  bridgeInstallState,
  disconnectBridgeOnServer,
} from '@main/core/switch-servers/disconnect-bridge';
import {
  addBridgeTeam,
  addRoomAgents,
  agentExistsOnServer,
  checkSlackTokens,
  fetchSlackOwnAppSetup,
  beginChatClaim,
  changeTemplateRun,
  createRoomFromTemplate,
  runTemplateDocument,
  runTemplateWithAgents,
  type TemplateRunAgent,
  type TemplateRunResult,
  createTemplate,
  deleteRoom,
  deleteTemplate,
  disconnectChat,
  exportRoomYaml,
  fetchAddressingPolicy,
  fetchAgentManagementAccess,
  fetchAgentRooms,
  fetchAgents,
  fetchAllExternalUsers,
  fetchBridges,
  fetchBridgeTeams,
  beginMessagingAppInstall,
  fetchBridgeTypes,
  fetchConnectedChats,
  fetchManagedAgent,
  fetchMessagingApps,
  fetchMyIdentities,
  fetchRoomAgentIds,
  fetchRoomDetail,
  fetchRoomGroups,
  fetchRoomRoles,
  fetchRooms,
  fetchTemplateDetail,
  fetchTemplateRuns,
  fetchTemplates,
  fetchTemplateSchema,
  GatewayError,
  ownsOwnerAddressedAgent,
  releaseBridgeIdentity,
  removeBridgeTeam,
  removeRoomAgent,
  type StoredTemplateDetail,
  type StoredTemplateSummary,
  type ProvisionFromTemplateResult,
  type TemplateRun,
  type TemplateVisibility,
  updateAddressingPolicy,
  fetchConnectionAgents,
  fetchServiceGrants,
  fetchWorkspaceServices,
  getConnectionCatalog,
  getGitHubConnection,
  connectServiceWithKey,
  disconnectGitHub,
  disconnectService,
  setServiceGrant,
  setWorkspaceService,
  removeServiceGrant,
  updateCanManageAgents,
  updateAgentDescription,
  updateAgentDisplayName,
  renameAgent,
  updateAgentIcon,
  updateRoom,
  updateTemplate,
} from '@main/core/switch-servers/gateway-client';
import {
  claimIdentityOnServer,
  searchDirectoryOnServer,
} from '@main/core/switch-servers/identities';
import { hostUnreachable } from '@main/core/switch-servers/require-server';
import { serverKindOf } from '@main/core/switch-servers/servers-store';
import {
  cancelServiceBrowserFlow,
  getServiceBrowserFlow,
  startServiceBrowserFlow,
} from '@main/core/switch-servers/service-browser-flow';
import { saveTeamsPackage } from '@main/core/switch-servers/teams-package';
import { updateBridgeOnServer } from '@main/core/switch-servers/update-bridge';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { bridgePlatformOfType } from '@main/core/telemetry/bridge-platform';
import type {
  TelemetryBridgeFailure,
  TelemetryBridgePlatform,
  TelemetryOutcome,
  TelemetryRoomAgentsDirection,
  TelemetryRoomCreateFailure,
  TelemetryRoomCreateSource,
  TelemetryServerKind,
} from '@main/core/telemetry/events';
import { entryPointOf, roomAgentsDirectionOf } from '@main/core/telemetry/narrow';
import { telemetryService, trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import type {
  SlackOwnAppSetup,
  SlackTokensChecked,
} from '@shared/core/switch-servers/own-app-setup';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import type {
  BridgeInstallState,
  AddressingPolicy,
  AgentRenameOutcome,
  AddTeamsTeamResult,
  AgentIconBackfill,
  AgentVerifyResult,
  BridgeDirectorySearchResult,
  ChatClaim,
  ClaimIdentityParams,
  ConnectedChat,
  ClaimIdentityResult,
  CreateBridgeParams,
  CreateBridgeResult,
  CreateRoomParams,
  CreateRoomResult,
  DeleteBridgeParams,
  DeleteBridgeResult,
  LinkedIdentity,
  MessagingApps,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  RemoveTeamsTeamResult,
  RetireOutcome,
  SwitchServer,
  TeamsTeamsResult,
  UpdateBridgeParams,
  UpdateBridgeResult,
  UpdateRoomParams,
} from '@shared/core/switch-servers/switch-servers';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  addWorkspaceJoinDomain,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  listWorkspaceJoinDomains,
  removeWorkspaceJoinDomain,
  revokeWorkspaceInvitation,
} from './invitations';
import { listServersWithoutMembership } from './reconcile-workspaces';
import {
  withReachableWorkspaceSession,
  withWorkspaceSession,
  workspaceServer,
} from './workspace-session';
import { getActiveWorkspaceId, listWorkspaces, setActiveWorkspaceId } from './workspaces-store';

/** A bridge result's discriminant as a code. Never the message beside it. */
function bridgeFailureReason(kind: string): TelemetryBridgeFailure {
  switch (kind) {
    case 'created':
      return 'none';
    case 'unauthenticated':
      return 'unauthenticated';
    case 'forbidden':
      return 'forbidden';
    case 'invalid':
      return 'invalid';
    default:
      return 'error';
  }
}

/** A room-create result's discriminant as a code. */
function roomCreateFailureReason(result: CreateRoomResult): TelemetryRoomCreateFailure {
  switch (result.kind) {
    case 'created':
      return 'none';
    case 'unauthenticated':
      return 'unauthenticated';
    case 'bridge-unavailable':
      return 'bridge_unavailable';
    case 'invalid':
      return 'invalid';
    default:
      return 'error';
  }
}

/**
 * Which platform a bridge id is on.
 *
 * A lookup rather than a field: these operations take a bridge id, and the type
 * either never appears (a delete) or appears only on success (a room). Best
 * effort — an unreachable server yields `unknown` rather than failing the
 * operation it is only describing.
 *
 * **Never awaited by a caller doing real work.** It asks the gateway, and making
 * someone wait on a network round trip so we can describe what they did would
 * put reporting in the path of the thing being reported. `reportWithBridge` is
 * how the answer is used once it arrives.
 *
 * It takes its own lease, so it must be started outside one: unawaited inside
 * another call's lease it would be left addressing whatever workspace the
 * session had moved on to. Where the answer is only readable before the work —
 * a delete — read it in that call's lease with
 * {@link bridgePlatformOnServer} instead.
 */
function bridgePlatformOf(
  workspaceId: string,
  bridgeId: string | null | undefined
): Promise<TelemetryBridgePlatform> {
  if (!bridgeId) return Promise.resolve('unknown');
  return withWorkspaceSession(workspaceId, fetchBridges)
    .then((bridges) => bridgePlatformOfType(bridges.find((b) => b.id === bridgeId)?.type))
    .catch((): TelemetryBridgePlatform => 'unknown');
}

/** {@link bridgePlatformOf} against a server already leased by the caller. */
function bridgePlatformOnServer(
  server: SwitchServer,
  bridgeId: string | null | undefined
): Promise<TelemetryBridgePlatform> {
  if (!bridgeId) return Promise.resolve('unknown');
  return fetchBridges(server)
    .then((bridges) => bridgePlatformOfType(bridges.find((b) => b.id === bridgeId)?.type))
    .catch((): TelemetryBridgePlatform => 'unknown');
}

/**
 * Report once the platform is known, without anyone waiting for it.
 *
 * The event arrives a moment after the action rather than with it, which costs
 * nothing: it carries its own timestamp, taken when the work happened.
 */
function reportWithBridge(
  platform: Promise<TelemetryBridgePlatform>,
  emit: (platform: TelemetryBridgePlatform) => void
): void {
  void platform.then(emit).catch(() => {});
}

/** The same, for a room create whose other properties are already known. */
function reportRoomCreated(
  workspaceId: string,
  bridgeId: string | null | undefined,
  rest: {
    server_kind: TelemetryServerKind;
    agent_count: number;
    has_instructions: boolean;
    failure_reason: TelemetryRoomCreateFailure;
    source: TelemetryRoomCreateSource;
  }
): void {
  reportWithBridge(bridgePlatformOf(workspaceId, bridgeId), (bridge_platform) =>
    trackEvent('room_created', {
      ...rest,
      bridge_platform,
      outcome: rest.failure_reason === 'none' ? 'success' : 'failure',
    })
  );
}

/** The rooms a template run made: one, a group's, or none for a run with no room half. */
function templateRoomIds(room: ProvisionFromTemplateResult | null): string[] {
  if (room === null) return [];
  return room.kind === 'room' ? [room.roomId] : room.rooms.map((r) => r.roomId);
}

type CreatedTemplateAgent = Extract<
  TemplateRunResult,
  { kind: 'created' }
>['createdAgents'][number];

/** What a template made, as the reports below need it. */
type TemplateMade = {
  room: ProvisionFromTemplateResult | null;
  /** Null for a template that makes rooms only. */
  agents: {
    created: CreatedTemplateAgent[];
    /** Each agent's provider by slot, where the caller declared it. */
    declaredProviders: ReadonlyMap<string, string>;
    /** Where the run was started. */
    entryPoint: UiEntryPoint;
  } | null;
};

function logUnreported(what: 'room' | 'agent' | 'room or agent', error: unknown): void {
  log.warn(`A ${what} a template made could not be read back to report it`, {
    event: 'telemetry_template_made',
    errorCode: error instanceof GatewayError ? error.kind : 'error',
  });
}

/**
 * Report what a template made: each room as `room_created` from a template,
 * and each agent as `agent_created`.
 *
 * The run's result names what it made and little else, so what the events
 * carry that nobody declared — a room's platform, agents and instructions, the
 * provider of an agent a document run chose — is read back from the server.
 * That is work done only to describe the run, so it is done only when an event
 * could be sent, all under one lease taken after the run's own has ended, and
 * nobody waits for it. What cannot be read back is logged, not guessed.
 */
async function reportTemplateMade(
  workspaceId: string,
  server: SwitchServer,
  made: TemplateMade
): Promise<void> {
  const roomIds = templateRoomIds(made.room);
  const agents = made.agents;
  if (roomIds.length === 0 && (agents === null || agents.created.length === 0)) return;
  if (!(await telemetryService.canSend())) return;

  const [rooms, providers] = await withWorkspaceSession(workspaceId, (leased) =>
    Promise.all([
      Promise.allSettled(roomIds.map((roomId) => fetchRoomDetail(leased, roomId))),
      Promise.allSettled(
        (agents?.created ?? []).map(async (agent) => {
          const declared = agents?.declaredProviders.get(agent.slot);
          if (declared !== undefined) return declared;
          const managed = await fetchManagedAgent(leased, agent.agentId);
          if (!managed) throw new Error('The agent the run made is not a managed agent.');
          return managed.provider;
        })
      ),
    ])
  );

  const serverKind = serverKindOf(server);
  for (const room of rooms) {
    if (room.status === 'rejected') {
      logUnreported('room', room.reason);
      continue;
    }
    trackEvent('room_created', {
      server_kind: serverKind,
      bridge_platform: bridgePlatformOfType(room.value.bridgeType),
      agent_count: room.value.agentCount,
      has_instructions: (room.value.instructions?.trim().length ?? 0) > 0,
      outcome: 'success',
      failure_reason: 'none',
      source: 'template',
    });
  }

  if (agents === null) return;
  for (const [i, provider] of providers.entries()) {
    if (provider.status === 'rejected') {
      logUnreported('agent', provider.reason);
      continue;
    }
    trackEvent('agent_created', {
      agent_type: agentTypeOf(provider.value),
      location: await managedAgentLocation(server.id, agents.created[i].machine.id),
      outcome: 'success',
      failure_reason: 'none',
      entry_point: entryPointOf(agents.entryPoint),
    });
  }
}

/** Start {@link reportTemplateMade} without anyone waiting for it, or for its failure. */
function reportTemplateMadeLater(
  workspaceId: string,
  server: SwitchServer,
  made: TemplateMade
): void {
  void reportTemplateMade(workspaceId, server, made).catch((error: unknown) =>
    logUnreported('room or agent', error)
  );
}

/**
 * Run a template that may create agents, and report what it made once the
 * run's lease has ended. Nothing is reported for a refused run: it made nothing.
 */
async function runTemplateReported(
  workspaceId: string,
  agents: { entryPoint: UiEntryPoint; declaredProviders: ReadonlyMap<string, string> },
  run: (server: SwitchServer) => Promise<TemplateRunResult>
): Promise<TemplateRunResult> {
  const { result, server } = await withWorkspaceSession(workspaceId, async (leased) => ({
    result: await run(leased),
    server: leased,
  }));
  if (result.kind === 'created') {
    reportTemplateMadeLater(workspaceId, server, {
      room: result.room,
      agents: { created: result.createdAgents, ...agents },
    });
  }
  return result;
}

/**
 * Everything that reads or writes what a workspace owns — its rooms, agents,
 * bridges and identities.
 *
 * Every one of these is addressed by workspace rather than by server, because
 * that is what the data belongs to: a server can host several workspaces, and
 * the same call against the same server means a different thing in each. The
 * server is resolved from the workspace, and the session's selected tenant is
 * made to match it, inside `withWorkspaceSession` — see there for why that is
 * the seam and not a courtesy at each call site.
 *
 * Registering a server, signing in to one and asking whether it can be reached
 * are not workspace-scoped and stay in `switch-servers/controller.ts`.
 */
export const workspacesController = createRPCController({
  list: (): Promise<Workspace[]> => listWorkspaces(),

  getActiveId: (): Promise<string | null> => getActiveWorkspaceId(),

  /** Servers where the signed-in account belongs to no workspace yet. */
  serversWithoutMembership: async (): Promise<string[]> => listServersWithoutMembership(),

  setActive: (workspaceId: string): Promise<void> => setActiveWorkspaceId(workspaceId),

  listAgents: (workspaceId: string): Promise<RemoteAgentSummary[]> =>
    withWorkspaceSession(workspaceId, fetchAgents),

  listRooms: (workspaceId: string): Promise<RemoteRoomSummary[]> =>
    withWorkspaceSession(workspaceId, fetchRooms),

  /** Admins and owners only; the gateway refuses anyone else with a 403. */
  listInvitations: listWorkspaceInvitations,

  createInvitation: createWorkspaceInvitation,

  revokeInvitation: revokeWorkspaceInvitation,

  /**
   * The e-mail domains anyone may join the workspace from. Admins and owners
   * only, and an admin may add only the domain of their own address.
   */
  listJoinDomains: listWorkspaceJoinDomains,

  addJoinDomain: addWorkspaceJoinDomain,

  removeJoinDomain: removeWorkspaceJoinDomain,

  listBridges: (workspaceId: string): Promise<RemoteBridge[]> =>
    withReachableWorkspaceSession(workspaceId, async (server) =>
      withResolvedHomeUrls(server, await fetchBridges(server))
    ),

  listBridgeTypes: (workspaceId: string): Promise<RemoteBridgeType[]> =>
    withReachableWorkspaceSession(workspaceId, fetchBridgeTypes),

  listMessagingApps: (workspaceId: string): Promise<MessagingApps> =>
    withReachableWorkspaceSession(workspaceId, fetchMessagingApps),

  /** Slack's create-app page, filled in with the app this server needs. */
  slackOwnAppSetup: (workspaceId: string): Promise<SlackOwnAppSetup> =>
    withReachableWorkspaceSession(workspaceId, fetchSlackOwnAppSetup),

  /** Whether a Slack app's tokens work, and its workspace. Do not log the tokens. */
  checkSlackTokens: (params: {
    workspaceId: string;
    botToken: string;
    appToken: string;
  }): Promise<SlackTokensChecked> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      checkSlackTokens(server, { botToken: params.botToken, appToken: params.appToken })
    ),

  /** Returns the platform's consent URL for the renderer to open in the browser. */
  beginMessagingAppInstall: (params: { workspaceId: string; platform: string }): Promise<string> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      beginMessagingAppInstall(server, params.platform)
    ),

  /** A one-time link and code that connect a chat; the chat itself is where it lands. */
  beginChatClaim: (params: { workspaceId: string; platform: string }): Promise<ChatClaim> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      beginChatClaim(server, params.platform)
    ),

  listConnectedChats: (params: {
    workspaceId: string;
    bridgeId: string;
  }): Promise<ConnectedChat[]> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      fetchConnectedChats(server, params.bridgeId)
    ),

  /** Open to members: a chat is a room, and rooms are members'. */
  disconnectChat: (params: { workspaceId: string; installId: string }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      disconnectChat(server, params.installId)
    ),

  /**
   * Attach a collaboration bridge to the chosen workspace (CHOO-1784).
   *
   * `params.connectionConfig` carries platform credentials. They cross the IPC
   * boundary once, on the way out, and are never written to Switch Console's disk
   * or returned to the renderer — the server stores them. Keep it that way: do
   * not log `params` here.
   */
  createBridge: (params: CreateBridgeParams): Promise<CreateBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, async (server) => {
      const platform = bridgePlatformOfType(params.bridgeType);
      let result: CreateBridgeResult;
      try {
        result = await createBridgeOnServer(server, {
          bridgeType: params.bridgeType,
          displayName: params.displayName,
          connectionConfig: params.connectionConfig,
          setAsDefault: params.setAsDefault,
          channelCreationEnabled: params.channelCreationEnabled,
        });
      } catch (error) {
        trackEvent('bridge_connected', {
          bridge_platform: platform,
          outcome: 'failure',
          failure_reason: 'error',
        });
        throw error;
      }
      trackEvent('bridge_connected', {
        bridge_platform: platform,
        outcome: result.kind === 'created' ? 'success' : 'failure',
        failure_reason: bridgeFailureReason(result.kind),
      });
      return result;
    }),

  /**
   * Edit a bridge's operator-controlled switches — today, only whether the
   * connection may create channels. Admin-only, like registering one; see
   * `updateBridgeOnServer` for the recoverable-failure mapping.
   */
  updateBridge: (params: UpdateBridgeParams): Promise<UpdateBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateBridgeOnServer(server, {
        bridgeId: params.bridgeId,
        channelCreationEnabled: params.channelCreationEnabled,
      })
    ),

  /**
   * Disconnect a messaging app from the chosen workspace. Admin-only.
   *
   * For a bridge created by pasting in credentials, the gateway deletes every
   * Switch room on the bridge on the way — see `deleteBridge`. For one created
   * by approving Switch's own app (an "install"), there are no rooms taken
   * with it: `disconnectBridgeOnServer` ends the install instead, which only
   * stops Switch listening in that organisation and leaves the rooms as
   * internal-only. Either way the renderer owns the confirmation, with copy
   * matching which of the two is about to happen; by the time this runs it is
   * deliberate.
   */
  deleteBridge: (params: DeleteBridgeParams): Promise<DeleteBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, async (server) => {
      // Read before the delete, because afterwards there is no bridge left to
      // read a platform from — and awaited, unlike every other report: left to
      // resolve on its own it would outlive the lease that scopes it to this
      // workspace. A disconnect is a confirmed, destructive action, not a hot
      // path, so it can afford the round trip.
      const platform = await bridgePlatformOnServer(server, params.bridgeId);
      const result = await disconnectBridgeOnServer(server, params.bridgeId);
      trackEvent('bridge_disconnected', {
        bridge_platform: platform,
        outcome: result.kind === 'deleted' ? 'success' : 'failure',
      });
      return result;
    }),

  /** Whether a bridge is backed by a live install, which decides what the
   * disconnect dialog says happens to its rooms. Admin-only. */
  bridgeInstallState: (params: {
    workspaceId: string;
    bridgeId: string;
  }): Promise<BridgeInstallState> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      bridgeInstallState(server, params.bridgeId)
    ),

  /** A distributed Teams bridge's team placement — which teams Switch can see,
   * which it is already in, and its chosen default. Admin-only. */
  listBridgeTeams: (params: { workspaceId: string; bridgeId: string }): Promise<TeamsTeamsResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      fetchBridgeTeams(server, params.bridgeId)
    ),

  /** Add Switch's distributed app to a team. Admin-only. */
  addBridgeTeam: (params: {
    workspaceId: string;
    bridgeId: string;
    teamId: string;
  }): Promise<AddTeamsTeamResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      addBridgeTeam(server, params.bridgeId, params.teamId)
    ),

  /** Remove Switch's distributed app from a team. Admin-only. */
  removeBridgeTeam: (params: {
    workspaceId: string;
    bridgeId: string;
    teamId: string;
  }): Promise<RemoveTeamsTeamResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      removeBridgeTeam(server, params.bridgeId, params.teamId)
    ),

  /**
   * Choose a distributed Teams bridge's default team — the one a channel
   * lands in when a room is created without naming one. Picking a default
   * also turns channel creation on: an installed bridge starts with it off,
   * and a default team with no way to create a channel in it would be a
   * setting with nothing it could do.
   */
  setDefaultTeamsTeam: (params: {
    workspaceId: string;
    bridgeId: string;
    teamId: string;
  }): Promise<UpdateBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateBridgeOnServer(server, {
        bridgeId: params.bridgeId,
        channelCreationEnabled: true,
        connectionConfig: { team_id: params.teamId },
      })
    ),

  /**
   * Save the distributed Teams app's install package to disk, for a Teams
   * admin to upload by hand when the app is not yet in the organisation's
   * catalogue. Returns the saved path, or null if the user cancelled the save
   * dialog.
   */
  downloadTeamsPackage: (params: {
    workspaceId: string;
    bridgeId: string;
    defaultFileName: string;
  }): Promise<string | null> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      saveTeamsPackage(server, params.bridgeId, params.defaultFileName)
    ),

  /**
   * Create a room in the chosen workspace, owned by the signed-in user. Room
   * provisioning stays server-side (`POST /gateway/rooms`); this only maps
   * recoverable failures onto a typed result the modal can act on.
   */
  createRoom: async (params: CreateRoomParams): Promise<CreateRoomResult> => {
    // A host that has gone down is counted before it is raised, which is why
    // this is here rather than left to the session seam.
    const known = await workspaceServer(params.workspaceId);

    // Every report is made out here, after the lease rather than inside it: the
    // platform lookup behind it takes a lease of its own, and one started from
    // within this call's would be left addressing whichever workspace the
    // session had moved on to by the time it ran.
    const report = (failure_reason: TelemetryRoomCreateFailure) =>
      reportRoomCreated(params.workspaceId, params.bridgeId, {
        server_kind: serverKindOf(known),
        agent_count: params.agentIds.length,
        has_instructions: (params.instructions?.trim().length ?? 0) > 0,
        failure_reason,
        source: 'dialog',
      });

    const unreachable = hostUnreachable(known);
    if (unreachable) {
      report('unreachable');
      throw unreachable;
    }

    let result: CreateRoomResult;
    try {
      result = await withWorkspaceSession(params.workspaceId, (server) =>
        createRoomOnServer(server, {
          name: params.name,
          description: params.description,
          instructions: params.instructions,
          bridgeId: params.bridgeId,
          agentIds: params.agentIds,
        })
      );
    } catch (error) {
      report('error');
      throw error;
    }

    report(roomCreateFailureReason(result));
    return result;
  },

  createRoomFromTemplate: async (
    workspaceId: string,
    yamlText: string,
    inputs: Record<string, string | number | boolean>,
    templateName: string
  ): Promise<ProvisionFromTemplateResult> => {
    const { result, server } = await withWorkspaceSession(workspaceId, async (leased) => ({
      result: await createRoomFromTemplate(leased, yamlText, inputs, templateName),
      server: leased,
    }));
    reportTemplateMadeLater(workspaceId, server, { room: result, agents: null });
    return result;
  },

  /**
   * Run a template that creates agents in one request: the agents as managed
   * agents on the signed-in person's machines, then its rooms. Nothing is
   * kept when it is refused; the result says why, per agent.
   */
  runTemplateWithAgents: (
    workspaceId: string,
    body: {
      agents: TemplateRunAgent[];
      yamlText: string | null;
      inputs: Record<string, string | number | boolean>;
      templateName: string;
      /** Where the run was started, for the agents it makes. */
      entryPoint: UiEntryPoint;
    }
  ): Promise<TemplateRunResult> => {
    const { entryPoint, ...run } = body;
    // The caller named each agent's provider, so none has to be read back.
    const declaredProviders = new Map(run.agents.map((agent) => [agent.slot, agent.provider]));
    return runTemplateReported(workspaceId, { entryPoint, declaredProviders }, (server) =>
      runTemplateWithAgents(server, run)
    );
  },

  /** Run a template from its document: the server works the agents and rooms out of it. */
  runTemplateDocument: (
    workspaceId: string,
    body: {
      template: string;
      inputs: Record<string, string | number | boolean>;
      filled: Record<string, string>;
      templateName: string;
      /** Where the run was started, for the agents it makes. */
      entryPoint: UiEntryPoint;
    }
  ): Promise<TemplateRunResult> => {
    const { entryPoint, ...run } = body;
    // The server chooses the agents from the document, so their providers are
    // read back rather than declared.
    return runTemplateReported(
      workspaceId,
      { entryPoint, declaredProviders: new Map() },
      (server) => runTemplateDocument(server, run)
    );
  },

  /** The runs the user may see, or null when the server does not record runs. */
  listTemplateRuns: (params: { workspaceId: string }): Promise<TemplateRun[] | null> =>
    withWorkspaceSession(params.workspaceId, fetchTemplateRuns),

  stopTemplateRun: (params: { workspaceId: string; rootRoomId: string }): Promise<TemplateRun> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      changeTemplateRun(server, params.rootRoomId, 'stop')
    ),

  continueTemplateRun: (params: {
    workspaceId: string;
    rootRoomId: string;
  }): Promise<TemplateRun> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      changeTemplateRun(server, params.rootRoomId, 'continue')
    ),

  fetchTemplateSchema: (workspaceId: string): Promise<Record<string, unknown> | null> =>
    withWorkspaceSession(workspaceId, fetchTemplateSchema),

  listTemplates: (params: {
    workspaceId: string;
    kind?: string;
    q?: string;
  }): Promise<StoredTemplateSummary[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchTemplates(server, { kind: params.kind, q: params.q })
    ),

  getTemplateDetail: (params: {
    workspaceId: string;
    templateId: string;
  }): Promise<StoredTemplateDetail> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchTemplateDetail(server, params.templateId)
    ),

  deleteTemplate: (params: { workspaceId: string; templateId: string }): Promise<void> =>
    withWorkspaceSession(params.workspaceId, (server) => deleteTemplate(server, params.templateId)),

  saveTemplate: (params: {
    workspaceId: string;
    name: string;
    description: string;
    kind: string;
    content: string;
    readVisibility?: TemplateVisibility;
    writeVisibility?: TemplateVisibility;
  }): Promise<StoredTemplateDetail> => {
    const { workspaceId, ...template } = params;
    return withWorkspaceSession(workspaceId, (server) => createTemplate(server, template));
  },

  updateTemplate: (params: {
    workspaceId: string;
    templateId: string;
    name?: string;
    description?: string;
    kind?: string;
    content?: string;
    readVisibility?: TemplateVisibility;
    writeVisibility?: TemplateVisibility;
  }): Promise<StoredTemplateDetail> => {
    const { workspaceId, templateId, ...changes } = params;
    return withWorkspaceSession(workspaceId, (server) =>
      updateTemplate(server, templateId, changes)
    );
  },

  exportRoomYaml: (params: { workspaceId: string; roomId: string }): Promise<string> =>
    withWorkspaceSession(params.workspaceId, (server) => exportRoomYaml(server, params.roomId)),

  listAgentRooms: (params: { workspaceId: string; agentId: string }): Promise<RemoteAgentRoom[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchAgentRooms(server, params.agentId)),

  listRoomRoles: (params: { workspaceId: string; roomId: string }): Promise<RemoteRoomRole[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchRoomRoles(server, params.roomId)),

  listRoomAgentIds: (params: { workspaceId: string; roomId: string }): Promise<string[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchRoomAgentIds(server, params.roomId)),

  /** One room in full, for its configuration page. */
  getRoomDetail: (params: { workspaceId: string; roomId: string }): Promise<RemoteRoomDetail> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchRoomDetail(server, params.roomId)),

  /**
   * Change a room's own settings. Failures propagate as-is — a user without
   * write access to the room needs the gateway's refusal, not a saved-looking
   * field holding a value the server never took.
   */
  updateRoom: (params: UpdateRoomParams): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateRoom(server, params.roomId, {
        description: params.description,
        instructions: params.instructions,
      })
    ),

  /**
   * Add agents to a room. Failures propagate as-is: the caller shows the
   * gateway's own words (e.g. an agent whose server-side client is not running,
   * which the gateway rejects) rather than a generic message.
   */
  addRoomAgents: (params: {
    workspaceId: string;
    roomId: string;
    agentIds: string[];
    /**
     * Which screen this came from. The same call serves both, and the
     * one-agent-to-many-rooms screen loops it once per room — so without this,
     * adding an agent to five rooms is indistinguishable from five people each
     * adding one agent.
     */
    direction: TelemetryRoomAgentsDirection;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, async (server) => {
      await addRoomAgents(server, params.roomId, params.agentIds);
      trackEvent('room_agents_added', {
        agent_count: params.agentIds.length,
        direction: roomAgentsDirectionOf(params.direction),
      });
    }),

  /** Remove one agent from a room. Membership only — the agent is not deleted. */
  removeRoomAgent: (params: {
    workspaceId: string;
    roomId: string;
    agentId: string;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      removeRoomAgent(server, params.roomId, params.agentId)
    ),

  /** Delete a room and everything in it, resolving to what became of its
   * platform channel (see `deleteRoom` in the gateway client). The channel is
   * kept unless `retireChannel` is true. The gateway enforces who may. */
  deleteRoom: async (params: {
    workspaceId: string;
    roomId: string;
    retireChannel?: boolean;
  }): Promise<RetireOutcome | null> => {
    const known = await workspaceServer(params.workspaceId);
    const report = (outcome: TelemetryOutcome) =>
      trackEvent('room_deleted', { server_kind: serverKindOf(known), outcome });

    // A host that has gone down refuses the deletion as surely as the gateway
    // can, and the event has an outcome precisely so a refusal is counted.
    const unreachable = hostUnreachable(known);
    if (unreachable) {
      report('failure');
      throw unreachable;
    }

    return withWorkspaceSession(params.workspaceId, async (server) => {
      let channel: RetireOutcome | null;
      try {
        channel = await deleteRoom(server, params.roomId, {
          retireChannel: params.retireChannel ?? false,
        });
      } catch (error) {
        report('failure');
        throw error;
      }
      report('success');
      return channel;
    });
  },

  listRoomGroups: (workspaceId: string): Promise<RemoteRoomGroup[]> =>
    withWorkspaceSession(workspaceId, fetchRoomGroups),

  listExternalUsers: (workspaceId: string): Promise<RemoteExternalUser[]> =>
    withWorkspaceSession(workspaceId, fetchAllExternalUsers),

  /**
   * Search a bridge's own user directory so the signed-in user can find
   * themselves before they have ever posted in the chat workspace (CHOO-2137).
   */
  searchBridgeDirectory: (params: {
    workspaceId: string;
    bridgeId: string;
    query: string;
  }): Promise<BridgeDirectorySearchResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      searchDirectoryOnServer(server, params.bridgeId, params.query)
    ),

  /** Claim a messaging-app account as the signed-in Switch user's own. */
  claimBridgeIdentity: async (params: ClaimIdentityParams): Promise<ClaimIdentityResult> => {
    const result = await withReachableWorkspaceSession(params.workspaceId, (server) =>
      claimIdentityOnServer(server, {
        bridgeId: params.bridgeId,
        externalUserId: params.externalUserId,
        username: params.username,
      })
    );
    // Reported after the lease, not inside it: the platform lookup takes a lease
    // of its own, and the bridge is still there to read afterwards.
    reportWithBridge(bridgePlatformOf(params.workspaceId, params.bridgeId), (bridge_platform) =>
      trackEvent('bridge_identity_claimed', {
        bridge_platform,
        outcome: result.kind === 'claimed' ? 'success' : 'failure',
      })
    );
    return result;
  },

  /** Give up a claim on a messaging-app account, leaving any other user's claim
   * on it in place. `userId` is whose claim to drop — null for the signed-in
   * user, which is the only one this app offers. Failures propagate: unclaiming
   * is a deliberate act, and reporting success for one that did not happen
   * would leave the user thinking an agent is no longer reachable by them when
   * it still is. */
  releaseBridgeIdentity: (params: {
    workspaceId: string;
    bridgeId: string;
    identityId: string;
    userId: string | null;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      releaseBridgeIdentity(server, params.bridgeId, params.identityId, params.userId)
    ),

  /** The messaging accounts the signed-in user has claimed in this workspace. */
  listMyIdentities: (workspaceId: string): Promise<LinkedIdentity[]> =>
    withWorkspaceSession(workspaceId, fetchMyIdentities),

  /** Whether the signed-in user owns an agent here that is set to answer its
   * owner, which is what makes an unlinked messaging account worth warning
   * about. One agent-list read, so callers need not ration it. */
  ownsOwnerAddressedAgent: (workspaceId: string): Promise<boolean> =>
    withWorkspaceSession(workspaceId, ownsOwnerAddressedAgent),

  /**
   * The agent's service grants and whether anyone can address it; null when
   * it is not the signed-in person's agent.
   */
  getServiceGrants: (params: {
    workspaceId: string;
    agentId: string;
  }): Promise<ServiceGrants | null> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchServiceGrants(server, params.agentId)
    ),

  /** The signed-in person's GitHub link in this workspace and the repositories it reaches. */
  getGitHubConnection: (workspaceId: string) =>
    withWorkspaceSession(workspaceId, getGitHubConnection),

  /** Every catalog service with the signed-in person's connection to it, in this workspace. */
  getServiceConnections: (workspaceId: string) =>
    withWorkspaceSession(workspaceId, getConnectionCatalog),

  /**
   * Start signing in to `service` for this workspace: the browser opens at the
   * vendor, and this Console's listener takes the result back. Resolves to the
   * flow's id.
   */
  startServiceConnection: (params: { workspaceId: string; service: string }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      startServiceBrowserFlow(server, params.service, (url) => appService.openExternal(url))
    ),

  getServiceFlow: (params: { workspaceId: string; service: string; flowId: string }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      getServiceBrowserFlow(server, params.service, params.flowId)
    ),

  cancelServiceConnection: (params: { workspaceId: string; service: string; flowId: string }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      cancelServiceBrowserFlow(server, params.service, params.flowId)
    ),

  /** Connect `service` with a key, or replace the key it has; Switch checks it with the vendor. */
  connectServiceWithKey: (params: {
    workspaceId: string;
    service: string;
    fields: Record<string, string>;
  }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      connectServiceWithKey(server, params.service, params.fields)
    ),

  /** Disconnect `service` in this workspace: its grants go with it. */
  disconnectService: (params: { workspaceId: string; service: string }) =>
    withWorkspaceSession(params.workspaceId, (server) => disconnectService(server, params.service)),

  disconnectGitHub: (workspaceId: string) =>
    withWorkspaceSession(workspaceId, (server) => disconnectGitHub(server)),

  /** The signed-in person's own agents in this workspace, and which are granted `service`. */
  getConnectionAgents: (params: { workspaceId: string; service: string }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchConnectionAgents(server, params.service)
    ),

  /**
   * The workspace's switch for each service, for a workspace admin; null when
   * its server has no workspace switch.
   */
  getWorkspaceServices: (workspaceId: string) =>
    withWorkspaceSession(workspaceId, fetchWorkspaceServices),

  /** Switch a service on or off for everyone in this workspace; workspace admins only. */
  setWorkspaceService: (params: { workspaceId: string; service: string; enabled: boolean }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      setWorkspaceService(server, params.service, params.enabled)
    ),

  /**
   * Create or replace the agent's grant on a service; owner only. Resolves to
   * a warning or null. `access` is left out of an on/off grant (a service
   * whose agents use the owner's own token), which takes the connection's.
   */
  setServiceGrant: (params: {
    workspaceId: string;
    agentId: string;
    service: string;
    access: 'read' | 'write' | null;
    resources: Record<string, unknown>;
  }): Promise<string | null> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      setServiceGrant(server, params.agentId, params.service, {
        access: params.access,
        resources: params.resources,
      })
    ),

  /** Remove the agent's grant on a service; owner only. Resolves to a warning or null. */
  removeServiceGrant: (params: {
    workspaceId: string;
    agentId: string;
    service: string;
  }): Promise<string | null> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      removeServiceGrant(server, params.agentId, params.service)
    ),

  getAddressingPolicy: (params: {
    workspaceId: string;
    agentId: string;
  }): Promise<AddressingPolicy | null> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchAddressingPolicy(server, params.agentId)
    ),

  updateAddressingPolicy: (params: {
    workspaceId: string;
    agentId: string;
    policy: AddressingPolicy | null;
  }): Promise<void> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      updateAddressingPolicy(server, params.agentId, params.policy)
    ),

  /** The agent's "can manage agents" capability, and whether the server runs
   * agent management, where alone it does anything. */
  getAgentManagementAccess: (params: {
    workspaceId: string;
    agentId: string;
  }): Promise<{ available: boolean; canManageAgents: boolean }> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchAgentManagementAccess(server, params.agentId)
    ),

  /** Turn the agent's "can manage agents" capability on or off; owner only. */
  updateCanManageAgents: (params: {
    workspaceId: string;
    agentId: string;
    enabled: boolean;
  }): Promise<void> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      updateCanManageAgents(server, params.agentId, params.enabled)
    ),

  /** Give this user's icon-less agents the avatar their name generates. Runs
   * once per workspace per app run; reports what happened so the caller can say
   * when the icons did not reach the server. */
  backfillAgentIcons: (workspaceId: string): Promise<AgentIconBackfill> =>
    withWorkspaceSession(workspaceId, (server) => backfillAgentIcons(workspaceId, server)),

  /** Set or clear an agent's icon. Returns the agent as the server now holds
   * it, so the caller refreshes from the stored value rather than the one it
   * hoped for. */
  updateAgentIcon: (params: {
    workspaceId: string;
    agentId: string;
    iconUrl: string | null;
  }): Promise<RemoteAgentSummary> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      updateAgentIcon(server, params.agentId, params.iconUrl)
    ),

  /** Change an agent's description. Returns the agent as the server now holds it. */
  updateAgentDescription: (params: {
    workspaceId: string;
    agentId: string;
    description: string;
  }): Promise<RemoteAgentSummary> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      updateAgentDescription(server, params.agentId, params.description)
    ),

  /** Set or clear an agent's display name. Returns the agent as the server now holds it. */
  updateAgentDisplayName: (params: {
    workspaceId: string;
    agentId: string;
    displayName: string | null;
  }): Promise<RemoteAgentSummary> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      updateAgentDisplayName(server, params.agentId, params.displayName)
    ),

  /**
   * Rename an agent on its Switch server, with its display name in the same
   * step. Only the server's half: a Console agent's own files follow through
   * `agents.renameLocal`.
   */
  renameAgent: (params: {
    workspaceId: string;
    agentId: string;
    name: string;
    displayName: string | null;
  }): Promise<AgentRenameOutcome> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      renameAgent(server, params.agentId, params.name, params.displayName)
    ),

  verifyAgent: (params: { workspaceId: string; agentId: string }): Promise<AgentVerifyResult> =>
    withWorkspaceSession(params.workspaceId, async (server) => {
      try {
        return (await agentExistsOnServer(server, params.agentId)) ? 'found' : 'not-found';
      } catch (cause) {
        if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
          return 'unauthenticated';
        }
        throw cause;
      }
    }),
});

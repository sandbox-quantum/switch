import { managedAgentLocator } from '@main/core/agent-migration/managed-agent-location';
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
  addRoomUsers,
  createRoomRole,
  deleteRoomRole,
  fetchArchivedRooms,
  fetchBridgePeople,
  setRoomAgentJoinEvents,
  setRoomArchived,
  setRoomGroup,
  updateRoomRole,
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
  fetchMyPendingIdentities,
  fetchUnconfirmedLinks,
  fetchRoomAgentIds,
  fetchRoomDetail,
  fetchRoomGroups,
  fetchRoomRoles,
  fetchRoomSchedules,
  fetchRooms,
  fetchTemplateDetail,
  fetchTemplateRuns,
  fetchTemplates,
  fetchTemplateSchema,
  GatewayError,
  ownsOwnerAddressedAgent,
  recordTemplateRun,
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
  connectServiceWithPaste,
  disconnectGitHub,
  disconnectService,
  setRoomAutoRoute,
  setServiceGrant,
  setWorkspaceService,
  removeServiceGrant,
  updateCanManageAgents,
  updateAgentDescription,
  updateAgentDisplayName,
  renameAgent,
  updateAgentIcon,
  syncRoomName,
  updateRoom,
  updateTemplate,
  addLinkedRoom,
  fetchLibrary,
  fetchLinkedRooms,
  fetchRoomDocument,
  fetchRoomResources,
  removeLinkedRoom,
  setRoomResourceAttached,
  createRoomSchedule,
  deleteRoomSchedule,
  setRoomSchedulePaused,
  updateRoomSchedule,
} from '@main/core/switch-servers/gateway-client';
import {
  cancelLinkRequestOnServer,
  claimIdentityOnServer,
  issueLinkCodeOnServer,
  requireLinkConfirmationOnServer,
  searchDirectoryOnServer,
} from '@main/core/switch-servers/identities';
import {
  createLibraryItem,
  deleteLibraryItem,
  fetchLibraryItem,
  fetchLibraryItemRooms,
  fetchLibraryItems,
  fetchReferenceTypes,
  updateLibraryItem,
  addPackageMember,
  fetchPackageMembers,
  removePackageMember,
  createReferenceType,
  deleteReferenceType,
  fetchManagedReferenceTypes,
  updateReferenceType,
} from '@main/core/switch-servers/library-client';
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
  TelemetryIdentityClaimOutcome,
  TelemetryOutcome,
  TelemetryRoomAgentsAddFailure,
  TelemetryRoomAgentsDirection,
  TelemetryRoomCreateFailure,
  TelemetryRoomCreateSource,
  TelemetryServerKind,
} from '@main/core/telemetry/events';
import {
  entryPointOf,
  identityLinkKindOf,
  roomAgentsDirectionOf,
} from '@main/core/telemetry/narrow';
import { telemetryService, trackEvent, trackEventAt } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import type {
  LibraryDeleteResult,
  LibraryDocument,
  LibraryItem,
  LibraryItemChanges,
  LibraryItemInput,
  LibraryItemRoom,
  LibraryKind,
  PackageMemberKind,
  ManagedReferenceType,
  PackageMemberRemoval,
  ReferenceTypeChanges,
  ReferenceTypeInput,
  ReferenceTypeOption,
} from '@shared/core/switch-servers/library';
import type {
  SlackOwnAppSetup,
  SlackTokensChecked,
} from '@shared/core/switch-servers/own-app-setup';
import type { ServicePaste } from '@shared/core/switch-servers/service-connection';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import type {
  BridgeInstallState,
  AddressingPolicy,
  AgentRenameOutcome,
  AddTeamsTeamResult,
  AgentIconBackfill,
  AgentVerifyResult,
  BridgeDirectorySearchResult,
  CancelLinkRequestResult,
  ChatClaim,
  BridgePerson,
  ClaimIdentityParams,
  ConnectedChat,
  ClaimIdentityResult,
  CreateBridgeParams,
  CreateBridgeResult,
  CreateRoomParams,
  CreateRoomResult,
  DeleteBridgeParams,
  DeleteBridgeResult,
  IssueLinkCodeResult,
  LinkedIdentity,
  MessagingApps,
  PendingIdentity,
  RequireLinkConfirmationResult,
  UnconfirmedLink,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RoomAutoRoute,
  SetRoomAutoRouteParams,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSchedule,
  RoomScheduleDraft,
  RemoteRoomSummary,
  RemoveTeamsTeamResult,
  RetireOutcome,
  RoomRoleInput,
  SwitchServer,
  TeamsTeamsResult,
  UpdateBridgeParams,
  UpdateBridgeResult,
  SyncRoomNameParams,
  UpdateRoomParams,
  LinkedRoom,
  RoomDocumentContent,
  RoomResource,
  RoomResourceKind,
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
  withWorkspaceIfSelected,
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
    case 'error':
      // The one generic result: the request never reached the server.
      return 'network';
  }
}

/**
 * A room create that threw, by the server's answer: the failures with no
 * result of their own. `error` is one with no answer to read.
 */
function roomCreateErrorReason(error: unknown): TelemetryRoomCreateFailure {
  if (!(error instanceof GatewayError) || error.kind !== 'http') return 'error';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'not_found';
  if (error.status === 409) return 'conflict';
  if (error.status !== undefined && error.status >= 500) return 'server_error';
  return 'error';
}

/** Adding agents to a room that threw, by the error's own type or the server's answer. */
function roomAgentsAddFailureReason(error: unknown): TelemetryRoomAgentsAddFailure {
  if (error instanceof HostUnreachableError) return 'unreachable';
  if (!(error instanceof GatewayError)) return 'error';
  if (error.kind === 'unauthorized') return 'unauthenticated';
  if (error.kind === 'network') return 'network';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'not_found';
  if (error.status === 409) return 'conflict';
  if (error.status === 400 || error.status === 422) return 'invalid';
  if (error.status !== undefined && error.status >= 500) return 'server_error';
  return 'error';
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
 * nothing: it carries its own timestamp, taken here, when the work happened.
 */
function reportWithBridge(
  platform: Promise<TelemetryBridgePlatform>,
  emit: (platform: TelemetryBridgePlatform, at: number) => void
): void {
  const at = Date.now();
  void platform.then((known) => emit(known, at)).catch(() => {});
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
  reportWithBridge(bridgePlatformOf(workspaceId, bridgeId), (bridge_platform, at) =>
    trackEventAt(
      'room_created',
      {
        ...rest,
        bridge_platform,
        outcome: rest.failure_reason === 'none' ? 'success' : 'failure',
      },
      at
    )
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

function logUnreported(what: string, error: unknown): void {
  log.warn(`${what} a template made could not be read back to report it`, {
    event: 'telemetry_template_made',
    errorCode: error instanceof GatewayError ? error.kind : 'error',
    error: String(error),
  });
}

/**
 * Report each room and agent a template made. What the run's result does not
 * say is read back, only when an event could be sent and only while the run's
 * workspace is still selected; what cannot be read is logged, not guessed.
 */
async function reportTemplateMade(
  workspaceId: string,
  server: SwitchServer,
  made: TemplateMade,
  at: number
): Promise<void> {
  const roomIds = templateRoomIds(made.room);
  const agents = made.agents;
  if (roomIds.length === 0 && (agents === null || agents.created.length === 0)) return;
  if (!(await telemetryService.canSend())) return;

  const read = await withWorkspaceIfSelected(workspaceId, (selected) =>
    Promise.all([
      Promise.allSettled(roomIds.map((roomId) => fetchRoomDetail(selected, roomId))),
      Promise.allSettled(
        (agents?.created ?? []).map(async (agent) => {
          const declared = agents?.declaredProviders.get(agent.slot);
          if (declared !== undefined) return declared;
          const managed = await fetchManagedAgent(selected, agent.agentId);
          if (!managed) throw new Error('The agent the run made is not a managed agent.');
          return managed.provider;
        })
      ),
    ])
  );
  if (read === null) {
    log.warn('What a template made was not reported: its workspace is no longer selected', {
      event: 'telemetry_template_made',
      errorCode: 'workspace_not_selected',
    });
    return;
  }
  const [rooms, providers] = read;

  const serverKind = serverKindOf(server);
  for (const room of rooms) {
    if (room.status === 'rejected') {
      logUnreported('A room', room.reason);
      continue;
    }
    trackEventAt(
      'room_created',
      {
        server_kind: serverKind,
        bridge_platform: bridgePlatformOfType(room.value.bridgeType),
        agent_count: room.value.agentCount,
        has_instructions: (room.value.instructions?.trim().length ?? 0) > 0,
        outcome: 'success',
        failure_reason: 'none',
        source: 'template',
      },
      at
    );
  }

  if (agents === null || agents.created.length === 0) return;
  const locate = await managedAgentLocator(server.id);
  for (const [i, provider] of providers.entries()) {
    if (provider.status === 'rejected') {
      logUnreported('An agent', provider.reason);
      continue;
    }
    trackEventAt(
      'agent_created',
      {
        agent_type: agentTypeOf(provider.value),
        location: locate(agents.created[i].machine.id),
        outcome: 'success',
        failure_reason: 'none',
        entry_point: entryPointOf(agents.entryPoint),
      },
      at
    );
  }
}

/** Run a template call, then report what it made (null: nothing) without waiting. */
async function runTemplateReported<R>(
  workspaceId: string,
  run: (server: SwitchServer) => Promise<R>,
  made: (result: R) => TemplateMade | null
): Promise<R> {
  const { result, server } = await withWorkspaceSession(workspaceId, async (leased) => ({
    result: await run(leased),
    server: leased,
  }));
  const report = made(result);
  if (report !== null) {
    void reportTemplateMade(workspaceId, server, report, Date.now()).catch((error: unknown) =>
      logUnreported('What', error)
    );
  }
  return result;
}

/** What a run that may create agents made: nothing when it was refused. */
function madeByRun(agents: {
  entryPoint: UiEntryPoint;
  declaredProviders: ReadonlyMap<string, string>;
}): (result: TemplateRunResult) => TemplateMade | null {
  return (result) =>
    result.kind === 'created'
      ? { room: result.room, agents: { created: result.createdAgents, ...agents } }
      : null;
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

  /** Admins only; the gateway refuses anyone else with a 403. */
  listInvitations: listWorkspaceInvitations,

  createInvitation: createWorkspaceInvitation,

  revokeInvitation: revokeWorkspaceInvitation,

  /**
   * The e-mail domains anyone may join the workspace from. Admins only, and an
   * admin may add only the domain of their own address.
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
  updateBridge: (
    params: Omit<UpdateBridgeParams, 'connectionConfig'>
  ): Promise<UpdateBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateBridgeOnServer(server, {
        bridgeId: params.bridgeId,
        channelCreationEnabled: params.channelCreationEnabled,
      })
    ),

  /**
   * Put new tokens on a connection to the workspace's own bot, after the old
   * ones were rotated or leaked. The server keeps the rest of the connection's
   * settings and restarts it with them; its rooms are untouched. Admin-only.
   * The tokens go to the server and nowhere else.
   */
  replaceBridgeTokens: (params: {
    workspaceId: string;
    bridgeId: string;
    tokens: Record<string, string>;
  }): Promise<UpdateBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateBridgeOnServer(server, {
        bridgeId: params.bridgeId,
        connectionConfig: params.tokens,
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
          userNames: params.userNames,
          channel: params.channel,
          groupId: params.groupId,
          access: params.access,
        })
      );
    } catch (error) {
      report(roomCreateErrorReason(error));
      throw error;
    }

    report(roomCreateFailureReason(result));
    return result;
  },

  createRoomFromTemplate: (
    workspaceId: string,
    yamlText: string,
    inputs: Record<string, string | number | boolean>,
    templateName: string
  ): Promise<ProvisionFromTemplateResult> =>
    runTemplateReported(
      workspaceId,
      (server) => createRoomFromTemplate(server, yamlText, inputs, templateName),
      (room) => ({ room, agents: null })
    ),

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
    return runTemplateReported(
      workspaceId,
      (server) => runTemplateWithAgents(server, run),
      madeByRun({ entryPoint, declaredProviders })
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
      /** The template the document is, when it is one; see `runTemplateDocument`. */
      templateId: string | null;
      /** Where the run was started, for the agents it makes. */
      entryPoint: UiEntryPoint;
    }
  ): Promise<TemplateRunResult> => {
    const { entryPoint, ...run } = body;
    // The server picks providers from the document's conditions, so they are read back.
    return runTemplateReported(
      workspaceId,
      (server) => runTemplateDocument(server, run),
      madeByRun({ entryPoint, declaredProviders: new Map() })
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

  /**
   * Count a stored or official template's run, once the whole run has
   * succeeded. Never fails: the run is done either way, so a server that does
   * not count runs, or one that cannot be reached, is logged and the run goes
   * uncounted.
   */
  recordTemplateRun: async (params: { workspaceId: string; templateId: string }): Promise<void> => {
    try {
      const counted = await withWorkspaceSession(params.workspaceId, (server) =>
        recordTemplateRun(server, params.templateId)
      );
      if (!counted) {
        log.warn('A template run was not counted: the server does not count it', {
          event: 'template_run_count',
          errorCode: 'not_counted',
          templateId: params.templateId,
        });
      }
    } catch (error) {
      log.warn('A template run was not counted', {
        event: 'template_run_count',
        errorCode: error instanceof GatewayError ? error.kind : 'error',
        templateId: params.templateId,
        error: String(error),
      });
    }
  },

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
  /** Name a room after its linked channel. Refusals propagate in the gateway's own words. */
  syncRoomName: (params: SyncRoomNameParams): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      syncRoomName(server, params.roomId)
    ),

  updateRoom: (params: UpdateRoomParams): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateRoom(server, params.roomId, {
        name: params.name,
        description: params.description,
        instructions: params.instructions,
        readVisibility: params.readVisibility,
        writeVisibility: params.writeVisibility,
      })
    ),

  /** File a room under a group, or take it out of one (null). */
  setRoomGroup: (params: {
    workspaceId: string;
    roomId: string;
    groupId: string | null;
  }): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      setRoomGroup(server, params.roomId, params.groupId)
    ),

  /** Define a role in a room; resolves to the room's roles as they now stand. */
  createRoomRole: (params: {
    workspaceId: string;
    roomId: string;
    role: RoomRoleInput;
  }): Promise<RemoteRoomRole[]> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      createRoomRole(server, params.roomId, params.role)
    ),

  /** Change a role's instructions or exclusivity; its name is fixed. */
  updateRoomRole: (params: {
    workspaceId: string;
    roomId: string;
    name: string;
    instructions?: string;
    exclusive?: boolean;
  }): Promise<RemoteRoomRole[]> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateRoomRole(server, params.roomId, params.name, {
        instructions: params.instructions,
        exclusive: params.exclusive,
      })
    ),

  deleteRoomRole: (params: {
    workspaceId: string;
    roomId: string;
    name: string;
  }): Promise<RemoteRoomRole[]> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      deleteRoomRole(server, params.roomId, params.name)
    ),

  /** Whether one member agent is told when someone joins the room. */
  setRoomAgentJoinEvents: (params: {
    workspaceId: string;
    roomId: string;
    agentId: string;
    receivesJoinEvents: boolean;
  }): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      setRoomAgentJoinEvents(server, params.roomId, params.agentId, params.receivesJoinEvents)
    ),

  /** Invite people to a bridged room by their messaging-app usernames. */
  addRoomUsers: (params: {
    workspaceId: string;
    roomId: string;
    userNames: string[];
  }): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      addRoomUsers(server, params.roomId, params.userNames)
    ),

  /** Archive a room, or bring it back. */
  setRoomArchived: (params: {
    workspaceId: string;
    roomId: string;
    archived: boolean;
  }): Promise<RemoteRoomDetail> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      setRoomArchived(server, params.roomId, params.archived)
    ),

  /** The archived rooms the signed-in user can see. */
  listArchivedRooms: (params: { workspaceId: string }): Promise<RemoteRoomSummary[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchArchivedRooms(server)),

  /** What is attached to a room, of one kind. */
  listRoomResources: (params: {
    workspaceId: string;
    roomId: string;
    kind: RoomResourceKind;
  }): Promise<RoomResource[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchRoomResources(server, params.roomId, params.kind)
    ),

  /** The library items of one kind the signed-in person may attach. */
  listLibrary: (params: { workspaceId: string; kind: RoomResourceKind }): Promise<RoomResource[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchLibrary(server, params.kind)),

  /** Attach a library item to a room or detach it. Refusals propagate in the gateway's words. */
  setRoomResourceAttached: (params: {
    workspaceId: string;
    roomId: string;
    kind: RoomResourceKind;
    resourceId: string;
    attached: boolean;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      setRoomResourceAttached(
        server,
        params.roomId,
        params.kind,
        params.resourceId,
        params.attached
      )
    ),

  /** A document attached to a room, read in full. */
  getRoomDocument: (params: {
    workspaceId: string;
    roomId: string;
    documentId: string;
  }): Promise<RoomDocumentContent> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchRoomDocument(server, params.roomId, params.documentId)
    ),

  /** The workspace library's references or documents the signed-in person may read. */
  listLibraryItems: (params: { workspaceId: string; kind: LibraryKind }): Promise<LibraryItem[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchLibraryItems(server, params.kind)),

  /** One library item; a document comes with its content. */
  getLibraryItem: (params: {
    workspaceId: string;
    kind: LibraryKind;
    itemId: string;
  }): Promise<LibraryItem | LibraryDocument> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchLibraryItem(server, params.kind, params.itemId)
    ),

  /** Add a reference or document to the library. Refusals propagate in the gateway's words. */
  createLibraryItem: (params: {
    workspaceId: string;
    kind: LibraryKind;
    input: LibraryItemInput;
  }): Promise<LibraryItem> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      createLibraryItem(server, params.kind, params.input)
    ),

  /** Change a library item. */
  updateLibraryItem: (params: {
    workspaceId: string;
    kind: LibraryKind;
    itemId: string;
    changes: LibraryItemChanges;
  }): Promise<LibraryItem | LibraryDocument> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateLibraryItem(server, params.kind, params.itemId, params.changes)
    ),

  /** Delete a library item, detaching it from its rooms and packages. */
  deleteLibraryItem: (params: {
    workspaceId: string;
    kind: LibraryKind;
    itemId: string;
  }): Promise<LibraryDeleteResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      deleteLibraryItem(server, params.kind, params.itemId)
    ),

  /** The rooms a library item is attached to. */
  listLibraryItemRooms: (params: {
    workspaceId: string;
    kind: LibraryKind;
    itemId: string;
  }): Promise<LibraryItemRoom[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchLibraryItemRooms(server, params.kind, params.itemId)
    ),

  /** The references or documents a package holds. */
  listPackageMembers: (params: {
    workspaceId: string;
    packageId: string;
    kind: PackageMemberKind;
  }): Promise<LibraryItem[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchPackageMembers(server, params.packageId, params.kind)
    ),

  /** Put a reference or document in a package, or take it out. Refusals propagate in the gateway's words. */
  addPackageMember: (params: {
    workspaceId: string;
    packageId: string;
    kind: PackageMemberKind;
    memberId: string;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      addPackageMember(server, params.packageId, params.kind, params.memberId)
    ),

  removePackageMember: (params: {
    workspaceId: string;
    packageId: string;
    kind: PackageMemberKind;
    memberId: string;
  }): Promise<PackageMemberRemoval> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      removePackageMember(server, params.packageId, params.kind, params.memberId)
    ),

  /** The types a new reference may be given. */
  listReferenceTypes: (params: { workspaceId: string }): Promise<ReferenceTypeOption[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchReferenceTypes(server)),

  /** The reference types the signed-in person may change. */
  listManagedReferenceTypes: (params: { workspaceId: string }): Promise<ManagedReferenceType[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchManagedReferenceTypes(server)),

  /** Add, change or delete a reference type. Refusals propagate in the gateway's words. */
  createReferenceType: (params: {
    workspaceId: string;
    input: ReferenceTypeInput;
  }): Promise<ManagedReferenceType> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      createReferenceType(server, params.input)
    ),

  updateReferenceType: (params: {
    workspaceId: string;
    type: string;
    changes: ReferenceTypeChanges;
  }): Promise<ManagedReferenceType> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateReferenceType(server, params.type, params.changes)
    ),

  deleteReferenceType: (params: { workspaceId: string; type: string }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      deleteReferenceType(server, params.type)
    ),

  /** The rooms a room points at. */
  listLinkedRooms: (params: { workspaceId: string; roomId: string }): Promise<LinkedRoom[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchLinkedRooms(server, params.roomId)),

  /** Point a room at another. */
  addLinkedRoom: (params: {
    workspaceId: string;
    roomId: string;
    targetRoomId: string;
    label: string;
  }): Promise<LinkedRoom> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      addLinkedRoom(server, params.roomId, params.targetRoomId, params.label)
    ),

  /** Stop a room pointing at another. */
  removeLinkedRoom: (params: {
    workspaceId: string;
    roomId: string;
    targetRoomId: string;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      removeLinkedRoom(server, params.roomId, params.targetRoomId)
    ),

  /** The people Switch knows on one bridge, with who linked each, for offering them to a room. */
  listBridgePeople: (params: { workspaceId: string; bridgeId: string }): Promise<BridgePerson[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchBridgePeople(server, params.bridgeId)
    ),

  /** A room's schedules, for its configuration page. */
  listRoomSchedules: (params: {
    workspaceId: string;
    roomId: string;
  }): Promise<RemoteRoomSchedule[]> =>
    withWorkspaceSession(params.workspaceId, (server) => fetchRoomSchedules(server, params.roomId)),

  /**
   * Add, change, pause or remove one of a room's schedules. Failures propagate
   * as-is, so a refusal (no write access, an agent not in the room, a time
   * already past) reaches the form in the server's own words.
   */
  createRoomSchedule: (params: {
    workspaceId: string;
    roomId: string;
    draft: RoomScheduleDraft;
  }): Promise<RemoteRoomSchedule> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      createRoomSchedule(server, params.roomId, params.draft)
    ),

  updateRoomSchedule: (params: {
    workspaceId: string;
    roomId: string;
    scheduleId: string;
    draft: RoomScheduleDraft;
  }): Promise<RemoteRoomSchedule> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      updateRoomSchedule(server, params.roomId, params.scheduleId, params.draft)
    ),

  setRoomSchedulePaused: (params: {
    workspaceId: string;
    roomId: string;
    scheduleId: string;
    paused: boolean;
  }): Promise<RemoteRoomSchedule> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      setRoomSchedulePaused(server, params.roomId, params.scheduleId, params.paused)
    ),

  deleteRoomSchedule: (params: {
    workspaceId: string;
    roomId: string;
    scheduleId: string;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      deleteRoomSchedule(server, params.roomId, params.scheduleId)
    ),

  /**
   * Turn auto-route on or off in a room, or name its triage agent, through the
   * same store `!auto-route` writes. Answers with the setting as it now stands;
   * a refusal propagates, so the toggle never shows a state the server didn't take.
   */
  setRoomAutoRoute: ({
    workspaceId,
    roomId,
    ...changes
  }: SetRoomAutoRouteParams): Promise<RoomAutoRoute> =>
    withReachableWorkspaceSession(workspaceId, (server) =>
      setRoomAutoRoute(server, roomId, changes)
    ),

  /**
   * Add agents to a room. Failures propagate as-is: the caller shows the
   * gateway's own words (e.g. an agent whose server-side client is not running,
   * which the gateway rejects) rather than a generic message. Reported either
   * way, with the reason a failure can be told by.
   */
  addRoomAgents: async (params: {
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
  }): Promise<void> => {
    const report = (failure_reason: TelemetryRoomAgentsAddFailure) =>
      trackEvent('room_agents_added', {
        agent_count: params.agentIds.length,
        direction: roomAgentsDirectionOf(params.direction),
        outcome: failure_reason === 'none' ? 'success' : 'failure',
        failure_reason,
      });
    try {
      await withReachableWorkspaceSession(params.workspaceId, (server) =>
        addRoomAgents(server, params.roomId, params.agentIds)
      );
    } catch (error) {
      report(roomAgentsAddFailureReason(error));
      throw error;
    }
    report('none');
  },

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

  /** Claim a messaging-app account as the signed-in Switch user's own. A
   * current server holds the link pending until a code is posted from the
   * account, and the result carries that code. */
  claimBridgeIdentity: async (params: ClaimIdentityParams): Promise<ClaimIdentityResult> => {
    const result = await withReachableWorkspaceSession(params.workspaceId, (server) =>
      claimIdentityOnServer(server, {
        bridgeId: params.bridgeId,
        externalUserId: params.externalUserId,
        username: params.username,
      })
    );
    const outcome: TelemetryIdentityClaimOutcome =
      result.kind === 'claimed' ? 'success' : result.kind === 'pending' ? 'pending' : 'failure';
    // Reported after the lease, not inside it: the platform lookup takes a lease
    // of its own, and the bridge is still there to read afterwards.
    reportWithBridge(bridgePlatformOf(params.workspaceId, params.bridgeId), (bridge_platform, at) =>
      trackEventAt('bridge_identity_claimed', { bridge_platform, outcome }, at)
    );
    return result;
  },

  /** A fresh code confirming the signed-in user's link to a messaging-app
   * account — one still pending, or one made before links had to be confirmed.
   * Replaces any code issued before. */
  issueIdentityLinkCode: (params: {
    workspaceId: string;
    bridgeId: string;
    identityId: string;
  }): Promise<IssueLinkCodeResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      issueLinkCodeOnServer(server, params.bridgeId, params.identityId)
    ),

  /**
   * Report that a link the confirmation screen was waiting on is confirmed.
   *
   * The code is posted in the chat app, so the screen watching for it is the
   * only thing that sees this happen; it says so, and `kind` is its own name for
   * the link. The server is asked before anything is reported, so a screen that
   * is wrong reports nothing — and nothing at all is asked while sharing is off.
   * Never fails: a report that cannot be made is logged and dropped.
   */
  reportIdentityConfirmed: async (params: {
    workspaceId: string;
    bridgeId: string;
    identityId: string;
    kind: string;
  }): Promise<void> => {
    const at = Date.now();
    try {
      if (!(await telemetryService.canSend())) return;
      const identities = await withWorkspaceSession(params.workspaceId, fetchMyIdentities);
      const confirmed = identities.find(
        (i) => i.id === params.identityId && i.bridgeId === params.bridgeId && i.verified
      );
      if (confirmed === undefined) return;
      trackEventAt(
        'bridge_identity_confirmed',
        {
          bridge_platform: bridgePlatformOfType(confirmed.bridgeType),
          link_kind: identityLinkKindOf(params.kind),
        },
        at
      );
    } catch (error) {
      log.warn('A confirmed link could not be checked to report it', {
        event: 'telemetry_identity_confirmed',
        errorCode: error instanceof GatewayError ? error.kind : 'error',
        error: String(error),
      });
    }
  },

  /** The links on a messaging app made before links had to be confirmed, which
   * still count. Admin only; empty on a server that predates them. */
  listUnconfirmedLinks: (params: {
    workspaceId: string;
    bridgeId: string;
  }): Promise<UnconfirmedLink[]> =>
    withWorkspaceSession(params.workspaceId, (server) =>
      fetchUnconfirmedLinks(server, params.bridgeId)
    ),

  /** Stop trusting a messaging app's older links until each owner confirms
   * theirs with a code. Admin only. */
  requireLinkConfirmation: (params: {
    workspaceId: string;
    bridgeId: string;
    /** The links the admin was shown; only these move. */
    links: Pick<UnconfirmedLink, 'id' | 'userId'>[];
  }): Promise<RequireLinkConfirmationResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      requireLinkConfirmationOnServer(server, params.bridgeId, params.links)
    ),

  /** Withdraw the signed-in user's confirmation waiting on a code. A link that
   * already works stays; unlinking is {@link releaseBridgeIdentity}. */
  cancelIdentityLinkRequest: (params: {
    workspaceId: string;
    bridgeId: string;
    identityId: string;
  }): Promise<CancelLinkRequestResult> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      cancelLinkRequestOnServer(server, params.bridgeId, params.identityId)
    ),

  /** Give up a claim on a messaging-app account, along with any confirmation
   * waiting on it, leaving any other user's claim on it in place. `userId` is
   * whose claim to drop — null for the signed-in user, which is the only one
   * this app offers. Failures propagate: unclaiming is a deliberate act, and
   * reporting success for one that did not happen would leave the user thinking
   * an agent is no longer reachable by them when it still is. */
  releaseBridgeIdentity: (params: {
    workspaceId: string;
    bridgeId: string;
    identityId: string;
    userId: string | null;
  }): Promise<void> =>
    withReachableWorkspaceSession(params.workspaceId, (server) =>
      releaseBridgeIdentity(server, params.bridgeId, params.identityId, params.userId)
    ),

  /** The messaging accounts linked to the signed-in user in this workspace —
   * only links that count; see {@link listMyPendingIdentities} for the rest. */
  listMyIdentities: (workspaceId: string): Promise<LinkedIdentity[]> =>
    withWorkspaceSession(workspaceId, fetchMyIdentities),

  /** The messaging accounts waiting for a code to confirm a link to the
   * signed-in user in this workspace. Empty on a server that predates
   * confirming links. */
  listMyPendingIdentities: (workspaceId: string): Promise<PendingIdentity[]> =>
    withWorkspaceSession(workspaceId, fetchMyPendingIdentities),

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
   * vendor, and this Console's listener takes the result back. `choices` are
   * what the person picked first (a vendor's site). Resolves to the flow's id,
   * and the server's callback where the browser returns through it.
   */
  startServiceConnection: (params: {
    workspaceId: string;
    service: string;
    choices: Record<string, string>;
  }) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      startServiceBrowserFlow(server, params.service, params.choices, (url) =>
        appService.openExternal(url)
      )
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

  /**
   * Connect `service` with a token or keys pasted in place of its sign-in, at
   * what was picked for its choices (a site); Switch checks them at the service.
   */
  connectServiceWithPaste: (params: { workspaceId: string; service: string } & ServicePaste) =>
    withWorkspaceSession(params.workspaceId, (server) =>
      connectServiceWithPaste(server, params.service, {
        method: params.method,
        fields: params.fields,
        choices: params.choices,
      })
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

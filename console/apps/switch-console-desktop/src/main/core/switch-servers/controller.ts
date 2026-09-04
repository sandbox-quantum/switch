import type { Result } from '@switch-console/shared';
import { foreignCredentialsOwner } from '@main/core/agents/agent-credentials-slot';
import { suggestAgentDefaults } from '@main/core/agents/agent-defaults';
import { resolveWorkspaceFsFor } from '@main/core/agents/agent-workspace-fs';
import { knownAgentTypeForProvider } from '@main/core/agents/known-agent-type';
import { propagateServerApiUrl } from '@main/core/agents/propagate-server-api-url';
import { registerAgentIdentity } from '@main/core/agents/register-agent-identity';
import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import { writeRemoteSwitchSettings } from '@main/core/agents/write-remote-switch-settings';
import {
  writeNeutralAgentSettingsFs,
  writeSwitchSettings,
} from '@main/core/agents/write-switch-settings';
import { appService } from '@main/core/app/service';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import {
  isManagedServerRunning,
  managedServerHostBlocked,
} from '@main/core/managed-switch-server/managed-server-status';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { bridgePlatformOfType } from '@main/core/telemetry/bridge-platform';
import type {
  TelemetryAuthMethod,
  TelemetryBridgeFailure,
  TelemetryBridgePlatform,
  TelemetryOutcome,
  TelemetryRoomAgentsDirection,
  TelemetryRoomCreateFailure,
  TelemetryServerKind,
  TelemetrySignInFailure,
} from '@main/core/telemetry/events';
import { roomAgentsDirectionOf } from '@main/core/telemetry/narrow';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import type {
  AddressingPolicy,
  AddServerParams,
  AgentDefaults,
  AgentVerifyResult,
  BridgeDirectorySearchResult,
  AgentIconBackfill,
  BundledChatSignIn,
  ClaimIdentityParams,
  ClaimIdentityResult,
  CreateBridgeParams,
  CreateBridgeResult,
  CreateRoomParams,
  CreateRoomResult,
  DeleteBridgeParams,
  DeleteBridgeResult,
  LinkedIdentity,
  PasswordLoginParams,
  ProvisionAgentParams,
  ProvisionAgentResult,
  ProvisionRemoteAgentParams,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  RenameServerParams,
  ServerConnectionStatus,
  SwitchAuthConfig,
  SwitchServer,
  UpdateBridgeParams,
  UpdateBridgeResult,
  UpdateRoomParams,
  UpdateServerParams,
  UpdateServerResult,
} from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type LoginError, oidcLogin, passwordLogin } from './auth';
import { backfillAgentIcons } from './backfill-agent-icons';
import { withResolvedHomeUrls } from './bridge-home-url';
import { bundledChatSignInFor } from './bundled-chat-sign-in';
import { createBridgeOnServer } from './create-bridge';
import { createRoomOnServer } from './create-room';
import {
  addRoomAgents,
  agentExistsOnServer,
  deleteBridge,
  deleteRoom,
  fetchAddressingPolicy,
  fetchAgentDetail,
  fetchAgentRooms,
  fetchAgents,
  fetchAllExternalUsers,
  fetchAuthConfig,
  fetchBridges,
  fetchBridgeTypes,
  fetchMe,
  fetchMyIdentities,
  fetchRoomAgentIds,
  fetchRoomDetail,
  fetchRoomGroups,
  fetchRoomRoles,
  fetchRooms,
  GatewayError,
  ownsOwnerAddressedAgent,
  releaseBridgeIdentity,
  removeRoomAgent,
  updateAddressingPolicy,
  updateAgentIcon,
  updateRoom,
} from './gateway-client';
import { openAuthenticatedGatewayPage } from './gateway-web';
import { claimIdentityOnServer, searchDirectoryOnServer } from './identities';
import {
  addServer,
  deleteSessionCookie,
  getActiveServerId,
  getServer,
  listServers,
  removeServer,
  renameServer,
  setActiveServerId,
  updateServer,
  serverKindOf,
} from './servers-store';
import { updateBridgeOnServer } from './update-bridge';

async function requireServer(serverId: string): Promise<SwitchServer> {
  const server = await getServer(serverId);
  if (!server) {
    throw new Error(`No Switch server with id ${serverId}`);
  }
  return server;
}

/**
 * The refusal a managed server's host being down produces, or null while it is
 * up.
 *
 * Returned rather than thrown so a path that reports its own outcome can count
 * the refusal before it propagates: the server is what an event describes
 * itself with, and a helper that throws leaves the caller holding nothing.
 */
function hostUnreachable(server: SwitchServer): HostUnreachableError | null {
  const blocked = managedServerHostBlocked(server);
  return blocked ? new HostUnreachableError(blocked) : null;
}

/**
 * Resolve a server and refuse to touch its gateway while the host it is managed
 * on is unreachable (CHOO-1780). `gatewayFetch` enforces the same rule at the
 * transport, so this is for the paths that reach the gateway some other way —
 * sign-in and the dashboard window — and for failing before the side effects a
 * write would otherwise start.
 */
async function requireReachableServer(serverId: string): Promise<SwitchServer> {
  const server = await requireServer(serverId);
  const unreachable = hostUnreachable(server);
  if (unreachable) throw unreachable;
  return server;
}

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

/** A sign-in's own error union, as a reportable code. Never its message. */
const SIGN_IN_FAILURE: Record<LoginError['kind'], TelemetrySignInFailure> = {
  invalid_credentials: 'invalid_credentials',
  cancelled: 'cancelled',
  failed: 'failed',
};

function signInFailureReason(result: Result<unknown, LoginError>): TelemetrySignInFailure {
  return result.success ? 'none' : SIGN_IN_FAILURE[result.error.kind];
}

/**
 * Reported by reason rather than by outcome: the two are the same fact, and a
 * sign-in that never left this machine — the server's host is down — has a
 * reason of its own but no result to read one from.
 */
function reportSignIn(
  method: TelemetryAuthMethod,
  server: SwitchServer,
  failureReason: TelemetrySignInFailure
): void {
  trackEvent('server_sign_in', {
    auth_method: method,
    server_kind: serverKindOf(server),
    outcome: failureReason === 'none' ? 'success' : 'failure',
    failure_reason: failureReason,
  });
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
 */
function bridgePlatformOf(
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
  server: SwitchServer,
  bridgeId: string | null | undefined,
  rest: {
    server_kind: TelemetryServerKind;
    agent_count: number;
    has_instructions: boolean;
    failure_reason: TelemetryRoomCreateFailure;
  }
): void {
  reportWithBridge(bridgePlatformOf(server, bridgeId), (bridge_platform) =>
    trackEvent('room_created', {
      ...rest,
      bridge_platform,
      outcome: rest.failure_reason === 'none' ? 'success' : 'failure',
    })
  );
}

export const switchServersController = createRPCController({
  listServers: (): Promise<SwitchServer[]> => listServers(),

  // Both outcomes are reported here rather than the success at the store's
  // insert, so that one press of Add produces exactly one event whichever way
  // it goes. Reported on the insert, because that is the whole of the action:
  // registering a URL is a row, and everything after it is bookkeeping.
  addServer: async (params: AddServerParams): Promise<SwitchServer> => {
    let server: SwitchServer;
    try {
      server = await addServer(params);
    } catch (error) {
      trackEvent('server_added', { server_kind: 'external', outcome: 'failure' });
      throw error;
    }
    trackEvent('server_added', { server_kind: 'external', outcome: 'success' });
    // The row has landed, so the server is added whatever happens next — this
    // reconciliation only unlinks agents pointing at servers that are gone.
    // Rejecting for it would tell the user their add failed while the store has
    // already reported it as done, and leave them to press Add again, which
    // registers the same server a second time rather than retrying the first.
    try {
      await resolveAgentServers();
    } catch (error) {
      log.warn('switch-servers: could not reconcile agent links after adding a server', { error });
    }
    return server;
  },

  updateServer: async (params: UpdateServerParams): Promise<UpdateServerResult> => {
    const previous = await requireServer(params.id);
    const server = await updateServer(params);
    await resolveAgentServers();

    // The API URL is what an agent's SWITCH_API_ENDPOINT points at. When it
    // changes, cascade it to every member agent's stored config so they don't
    // keep authenticating against the stale endpoint (CHOO-1431). Compare the
    // saved (normalised) values so a no-op edit doesn't rewrite configs.
    const apiUrlChanged = previous.apiUrl !== server.apiUrl;
    const propagatedAgents = apiUrlChanged
      ? await propagateServerApiUrl(server.id, server.apiUrl)
      : [];

    return { server, propagation: { apiUrlChanged, agents: propagatedAgents } };
  },

  renameServer: (params: RenameServerParams): Promise<SwitchServer> => renameServer(params),

  removeServer: (serverId: string): Promise<void> => removeServer(serverId),

  getActiveServerId: (): Promise<string | null> => getActiveServerId(),

  setActiveServer: (serverId: string): Promise<void> => setActiveServerId(serverId),

  getAuthConfig: async (serverId: string): Promise<SwitchAuthConfig> =>
    fetchAuthConfig(await requireReachableServer(serverId)),

  // Reported here rather than in `auth.ts`: the same functions are used to
  // re-authenticate a managed server on its own and to log in while starting a
  // stack, and neither of those is a person signing in.
  passwordLogin: async (params: PasswordLoginParams) => {
    const server = await requireServer(params.serverId);
    const unreachable = hostUnreachable(server);
    if (unreachable) {
      reportSignIn('password', server, 'unreachable');
      throw unreachable;
    }
    const result = await passwordLogin(server, params.email, params.password);
    reportSignIn('password', server, signInFailureReason(result));
    return result;
  },

  oidcLogin: async (serverId: string): Promise<Result<true, LoginError>> => {
    const server = await requireServer(serverId);
    const unreachable = hostUnreachable(server);
    if (unreachable) {
      reportSignIn('oidc', server, 'unreachable');
      throw unreachable;
    }
    const result = await oidcLogin(server);
    reportSignIn('oidc', server, signInFailureReason(result));
    return result;
  },

  logout: async (serverId: string): Promise<void> => {
    // Read before the cookie goes, so the kind of server is still knowable — and
    // caught, because nobody should be unable to sign out because of it.
    const server = await getServer(serverId).catch(() => null);
    await deleteSessionCookie(serverId);
    if (server) trackEvent('server_sign_out', { server_kind: serverKindOf(server) });
  },

  /**
   * Open a gateway web page (operator dashboard). For the managed local server —
   * whose session Switch Console owns — this opens an in-app window with the
   * `switch_auth` cookie injected, so the dashboard loads already signed in.
   * Remote servers open in the OS browser as before: we can't inject our
   * httponly cookie into the system browser, so an authenticated in-app window
   * is reserved for the local server. `url` must be on the server's gateway
   * origin.
   */
  openGatewayPage: async (params: { serverId: string; url: string }): Promise<void> => {
    const server = await requireReachableServer(params.serverId);
    if (server.managed) {
      await openAuthenticatedGatewayPage(server, params.url);
    } else {
      await appService.openExternal(params.url);
    }
  },

  getConnectionStatus: async (serverId: string): Promise<ServerConnectionStatus> => {
    const server = await requireServer(serverId);
    // A managed server whose stack isn't running is knowably unreachable — its
    // gateway port isn't listening — so probing it only yields a network error
    // that spams the logs (CHOO-1657). Report it as disconnected without the
    // round-trip; genuine failures for a running stack still surface below.
    if (server.managed && !isManagedServerRunning(server)) {
      return { serverId, connected: false, user: null };
    }
    try {
      const user = await fetchMe(server);
      return { serverId, connected: true, user };
    } catch (cause) {
      if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
        return { serverId, connected: false, user: null };
      }
      throw cause;
    }
  },

  listRemoteAgents: async (serverId: string): Promise<RemoteAgentSummary[]> =>
    fetchAgents(await requireServer(serverId)),

  getRemoteAgent: async (params: {
    serverId: string;
    agentId: string;
  }): Promise<RemoteAgentSummary> =>
    fetchAgentDetail(await requireServer(params.serverId), params.agentId),

  listRemoteRooms: async (serverId: string): Promise<RemoteRoomSummary[]> =>
    fetchRooms(await requireServer(serverId)),

  listRemoteBridges: async (serverId: string): Promise<RemoteBridge[]> => {
    const server = await requireReachableServer(serverId);
    return withResolvedHomeUrls(server, await fetchBridges(server));
  },

  listRemoteBridgeTypes: async (serverId: string): Promise<RemoteBridgeType[]> =>
    fetchBridgeTypes(await requireReachableServer(serverId)),

  /**
   * The bundled chat's address and sign-in for a managed server (CHOO-1787).
   *
   * The password crosses IPC only when the renderer asks — the card fetches on
   * expand, not on render — so it is not sitting in every server page's memory.
   * Do not log the result.
   */
  getBundledChatSignIn: async (serverId: string): Promise<BundledChatSignIn> =>
    bundledChatSignInFor(await getServer(serverId)),

  /**
   * Attach a collaboration bridge to the chosen server (CHOO-1784).
   *
   * `params.connectionConfig` carries platform credentials. They cross the IPC
   * boundary once, on the way out, and are never written to Switch Console's disk
   * or returned to the renderer — the server stores them. Keep it that way: do
   * not log `params` here.
   */
  createBridge: async (params: CreateBridgeParams): Promise<CreateBridgeResult> => {
    const server = await requireReachableServer(params.serverId);
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
  },

  /**
   * Edit a bridge's operator-controlled switches — today, only whether the
   * connection may create channels. Admin-only, like registering one; see
   * `updateBridgeOnServer` for the recoverable-failure mapping.
   */
  updateBridge: async (params: UpdateBridgeParams): Promise<UpdateBridgeResult> => {
    const server = await requireReachableServer(params.serverId);
    return updateBridgeOnServer(server, {
      bridgeId: params.bridgeId,
      channelCreationEnabled: params.channelCreationEnabled,
    });
  },

  /**
   * Disconnect a messaging app from the chosen server. Admin-only, and the
   * gateway deletes every Switch room on the bridge on the way — see
   * `deleteBridge`. The renderer owns the confirmation; by the time this runs
   * the rooms are being given up deliberately.
   */
  deleteBridge: async (params: DeleteBridgeParams): Promise<DeleteBridgeResult> => {
    const server = await requireReachableServer(params.serverId);
    // Started before the delete, because afterwards there is no bridge left to
    // read a platform from — but never waited on: see `reportWithBridge`.
    const platform = bridgePlatformOf(server, params.bridgeId);
    const result = await deleteBridge(server, params.bridgeId);
    reportWithBridge(platform, (bridge_platform) =>
      trackEvent('bridge_disconnected', {
        bridge_platform,
        outcome: result.kind === 'deleted' ? 'success' : 'failure',
      })
    );
    return result;
  },

  /**
   * Create a room on the chosen server, owned by the signed-in user. Room
   * provisioning stays server-side (`POST /gateway/rooms`); this only maps
   * recoverable failures onto a typed result the modal can act on.
   */
  createRoom: async (params: CreateRoomParams): Promise<CreateRoomResult> => {
    const server = await requireServer(params.serverId);
    const report = (failure_reason: TelemetryRoomCreateFailure) =>
      reportRoomCreated(server, params.bridgeId, {
        server_kind: serverKindOf(server),
        agent_count: params.agentIds.length,
        has_instructions: (params.instructions?.trim().length ?? 0) > 0,
        failure_reason,
      });

    const unreachable = hostUnreachable(server);
    if (unreachable) {
      report('unreachable');
      throw unreachable;
    }

    let result: CreateRoomResult;
    try {
      result = await createRoomOnServer(server, {
        name: params.name,
        description: params.description,
        instructions: params.instructions,
        bridgeId: params.bridgeId,
        agentIds: params.agentIds,
      });
    } catch (error) {
      report('error');
      throw error;
    }

    report(roomCreateFailureReason(result));
    return result;
  },

  listAgentRooms: async (params: {
    serverId: string;
    agentId: string;
  }): Promise<RemoteAgentRoom[]> =>
    fetchAgentRooms(await requireServer(params.serverId), params.agentId),

  listRoomRoles: async (params: { serverId: string; roomId: string }): Promise<RemoteRoomRole[]> =>
    fetchRoomRoles(await requireServer(params.serverId), params.roomId),

  listRoomAgentIds: async (params: { serverId: string; roomId: string }): Promise<string[]> =>
    fetchRoomAgentIds(await requireServer(params.serverId), params.roomId),

  /** One room in full, for its configuration page. */
  getRoomDetail: async (params: { serverId: string; roomId: string }): Promise<RemoteRoomDetail> =>
    fetchRoomDetail(await requireServer(params.serverId), params.roomId),

  /**
   * Change a room's own settings. Failures propagate as-is — a user without
   * write access to the room needs the gateway's refusal, not a saved-looking
   * field holding a value the server never took.
   */
  updateRoom: async (params: UpdateRoomParams): Promise<RemoteRoomDetail> =>
    updateRoom(await requireReachableServer(params.serverId), params.roomId, {
      description: params.description,
      instructions: params.instructions,
    }),

  /**
   * Add agents to a room. Failures propagate as-is: the caller shows the
   * gateway's own words (e.g. an agent whose server-side client is not running,
   * which the gateway rejects) rather than a generic message.
   */
  addRoomAgents: async (params: {
    serverId: string;
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
    await addRoomAgents(
      await requireReachableServer(params.serverId),
      params.roomId,
      params.agentIds
    );
    trackEvent('room_agents_added', {
      agent_count: params.agentIds.length,
      direction: roomAgentsDirectionOf(params.direction),
    });
  },

  /** Remove one agent from a room. Membership only — the agent is not deleted. */
  removeRoomAgent: async (params: {
    serverId: string;
    roomId: string;
    agentId: string;
  }): Promise<void> =>
    removeRoomAgent(await requireReachableServer(params.serverId), params.roomId, params.agentId),

  /** Delete a room and everything in it. The gateway enforces who may. */
  deleteRoom: async (params: { serverId: string; roomId: string }): Promise<void> => {
    const server = await requireServer(params.serverId);
    const report = (outcome: TelemetryOutcome) =>
      trackEvent('room_deleted', { server_kind: serverKindOf(server), outcome });

    // A host that has gone down refuses the deletion as surely as the gateway
    // can, and the event has an outcome precisely so a refusal is counted.
    const unreachable = hostUnreachable(server);
    if (unreachable) {
      report('failure');
      throw unreachable;
    }

    try {
      await deleteRoom(server, params.roomId);
    } catch (error) {
      report('failure');
      throw error;
    }
    report('success');
  },

  listRemoteRoomGroups: async (serverId: string): Promise<RemoteRoomGroup[]> =>
    fetchRoomGroups(await requireServer(serverId)),

  listRemoteExternalUsers: async (serverId: string): Promise<RemoteExternalUser[]> =>
    fetchAllExternalUsers(await requireServer(serverId)),

  /**
   * Search a bridge's own user directory so the signed-in user can find
   * themselves before they have ever posted in the workspace (CHOO-2137).
   */
  searchBridgeDirectory: async (params: {
    serverId: string;
    bridgeId: string;
    query: string;
  }): Promise<BridgeDirectorySearchResult> =>
    searchDirectoryOnServer(
      await requireReachableServer(params.serverId),
      params.bridgeId,
      params.query
    ),

  /** Claim a messaging-app account as the signed-in Switch user's own. */
  claimBridgeIdentity: async (params: ClaimIdentityParams): Promise<ClaimIdentityResult> => {
    const server = await requireReachableServer(params.serverId);
    const result = await claimIdentityOnServer(server, {
      bridgeId: params.bridgeId,
      externalUserId: params.externalUserId,
      username: params.username,
    });
    reportWithBridge(bridgePlatformOf(server, params.bridgeId), (bridge_platform) =>
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
  releaseBridgeIdentity: async (params: {
    serverId: string;
    bridgeId: string;
    identityId: string;
    userId: string | null;
  }): Promise<void> =>
    releaseBridgeIdentity(
      await requireReachableServer(params.serverId),
      params.bridgeId,
      params.identityId,
      params.userId
    ),

  /** The messaging accounts the signed-in user has claimed on this server. */
  listMyIdentities: async (serverId: string): Promise<LinkedIdentity[]> =>
    fetchMyIdentities(await requireServer(serverId)),

  /** Whether the signed-in user owns an agent here that is set to answer its
   * owner, which is what makes an unlinked messaging account worth warning
   * about. One agent-list read, so callers need not ration it. */
  ownsOwnerAddressedAgent: async (serverId: string): Promise<boolean> =>
    ownsOwnerAddressedAgent(await requireServer(serverId)),

  getAddressingPolicy: async (params: {
    serverId: string;
    agentId: string;
  }): Promise<AddressingPolicy | null> =>
    fetchAddressingPolicy(await requireServer(params.serverId), params.agentId),

  updateAddressingPolicy: async (params: {
    serverId: string;
    agentId: string;
    policy: AddressingPolicy | null;
  }): Promise<void> =>
    updateAddressingPolicy(await requireServer(params.serverId), params.agentId, params.policy),

  /** Give this user's icon-less agents the avatar their name generates. Runs
   * once per server per app run; reports what happened so the caller can say
   * when the icons did not reach the server. */
  backfillAgentIcons: async (serverId: string): Promise<AgentIconBackfill> =>
    backfillAgentIcons(await requireServer(serverId)),

  /** Set or clear an agent's icon. Returns the agent as the server now holds
   * it, so the caller refreshes from the stored value rather than the one it
   * hoped for. */
  updateAgentIcon: async (params: {
    serverId: string;
    agentId: string;
    iconUrl: string | null;
  }): Promise<RemoteAgentSummary> =>
    updateAgentIcon(await requireServer(params.serverId), params.agentId, params.iconUrl),

  verifyAgent: async (params: {
    serverId: string;
    agentId: string;
  }): Promise<AgentVerifyResult> => {
    const server = await requireServer(params.serverId);
    try {
      return (await agentExistsOnServer(server, params.agentId)) ? 'found' : 'not-found';
    } catch (cause) {
      if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
        return 'unauthenticated';
      }
      throw cause;
    }
  },

  suggestAgentDefaults: async (params: {
    dir: string;
    providerId: AgentProviderId;
  }): Promise<AgentDefaults> => suggestAgentDefaults(params.dir, params.providerId),

  /**
   * Register a new agent on the chosen server (owned by the signed-in user) and
   * write its credentials into the directory's `.claude/settings.local.json`.
   * This is the desktop equivalent of running the switch-connector `configure`
   * skill. Recoverable gateway failures are mapped to a typed result; the minted
   * token is written to disk and never returned.
   */
  provisionAgent: async (params: ProvisionAgentParams): Promise<ProvisionAgentResult> => {
    const server = await requireServer(params.serverId);

    const conflict = await foreignCredentialsOwner(null, params.dir, params.name, server.apiUrl);
    if (conflict !== null) return { kind: 'credentials-conflict', endpoint: conflict };

    const registered = await registerAgentIdentity(server, {
      name: params.name,
      description: params.description,
      repoDir: params.dir,
      autoSession: params.autoSession,
      iconUrl: agentAvatarUrlForName(params.name),
      // This flow asks for a name and nothing else, so there is no label to send.
      displayName: null,
      // Provisioning writes `.claude/settings.local.json` — this is the Claude
      // Code path by construction, not a fallback.
      agentType: knownAgentTypeForProvider('claude'),
    });
    if (registered.kind !== 'created') return registered;

    // The connector's SWITCH_API_ENDPOINT must point at the Switch core (agent
    // bridge), which is a distinct endpoint from the gateway.
    await writeSwitchSettings({
      dir: params.dir,
      apiEndpoint: server.apiUrl,
      agentId: registered.id,
    });

    // The settings file above carries no token (CHOO-1962), so the per-agent
    // credentials file is what actually provisions this agent.
    const workspace = await resolveWorkspaceFsFor(null, params.dir);
    try {
      await writeNeutralAgentSettingsFs(workspace.fs, {
        slug: params.name,
        apiEndpoint: server.apiUrl,
        apiToken: registered.apiKey,
        agentId: registered.id,
      });
    } finally {
      workspace.close();
    }

    return { kind: 'created', agentId: registered.id };
  },

  /**
   * Register a new Claude Code agent and write its credentials into a REMOTE
   * working directory over SSH — the remote-host equivalent of `provisionAgent`.
   * The agent has no local directory: its `.claude/settings.local.json` is
   * written on the host, where the runtime sidecar reads it (CHOO-1059).
   */
  provisionRemoteAgent: async (
    params: ProvisionRemoteAgentParams
  ): Promise<ProvisionAgentResult> => {
    const server = await requireServer(params.serverId);

    const conflict = await foreignCredentialsOwner(
      params.sshHost,
      params.remoteRepoDir,
      params.name,
      server.apiUrl
    );
    if (conflict !== null) return { kind: 'credentials-conflict', endpoint: conflict };

    const registered = await registerAgentIdentity(server, {
      name: params.name,
      description: params.description,
      repoDir: params.remoteRepoDir,
      autoSession: params.autoSession,
      iconUrl: agentAvatarUrlForName(params.name),
      // As locally: a name is all this flow collects.
      displayName: null,
      // Remote provisioning likewise writes `.claude/settings.local.json`.
      agentType: knownAgentTypeForProvider('claude'),
    });
    if (registered.kind !== 'created') return registered;

    const proxy = await ensureSshConnected(sshConnectionIdForHost(params.sshHost), params.sshHost);
    const fs = new SshFileSystem(proxy, params.remoteRepoDir);
    try {
      await writeRemoteSwitchSettings(fs, {
        apiEndpoint: server.apiUrl,
        agentId: registered.id,
      });
    } finally {
      fs.close();
    }

    // As locally: the settings file names the agent, the per-agent credentials
    // file carries its token — here in the VM's own working directory, which is
    // where its sessions will look.
    const workspace = await resolveWorkspaceFsFor(params.sshHost, params.remoteRepoDir);
    try {
      await writeNeutralAgentSettingsFs(workspace.fs, {
        slug: params.name,
        apiEndpoint: server.apiUrl,
        apiToken: registered.apiKey,
        agentId: registered.id,
      });
    } finally {
      workspace.close();
    }

    return { kind: 'created', agentId: registered.id };
  },
});

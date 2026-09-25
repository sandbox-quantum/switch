import { backfillAgentIcons } from '@main/core/switch-servers/backfill-agent-icons';
import { withResolvedHomeUrls } from '@main/core/switch-servers/bridge-home-url';
import { createBridgeOnServer } from '@main/core/switch-servers/create-bridge';
import { createRoomOnServer } from '@main/core/switch-servers/create-room';
import {
  addRoomAgents,
  agentExistsOnServer,
  changeTemplateRun,
  createRoomFromTemplate,
  createTemplate,
  deleteBridge,
  deleteRoom,
  deleteTemplate,
  exportRoomYaml,
  fetchAddressingPolicy,
  fetchAgentRooms,
  fetchAgents,
  fetchAllExternalUsers,
  fetchBridges,
  fetchBridgeTypes,
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
  removeRoomAgent,
  type StoredTemplateDetail,
  type StoredTemplateSummary,
  type ProvisionFromTemplateResult,
  type TemplateRun,
  type TemplateVisibility,
  updateAddressingPolicy,
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
import { updateBridgeOnServer } from '@main/core/switch-servers/update-bridge';
import { bridgePlatformOfType } from '@main/core/telemetry/bridge-platform';
import type {
  TelemetryBridgeFailure,
  TelemetryBridgePlatform,
  TelemetryOutcome,
  TelemetryRoomAgentsDirection,
  TelemetryRoomCreateFailure,
  TelemetryServerKind,
} from '@main/core/telemetry/events';
import { roomAgentsDirectionOf } from '@main/core/telemetry/narrow';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type {
  AddressingPolicy,
  AgentIconBackfill,
  AgentVerifyResult,
  BridgeDirectorySearchResult,
  ClaimIdentityParams,
  ClaimIdentityResult,
  CreateBridgeParams,
  CreateBridgeResult,
  CreateRoomParams,
  CreateRoomResult,
  DeleteBridgeParams,
  DeleteBridgeResult,
  LinkedIdentity,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  SwitchServer,
  UpdateBridgeParams,
  UpdateBridgeResult,
  UpdateRoomParams,
} from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { createRPCController } from '@shared/lib/ipc/rpc';
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

  setActive: (workspaceId: string): Promise<void> => setActiveWorkspaceId(workspaceId),

  listAgents: (workspaceId: string): Promise<RemoteAgentSummary[]> =>
    withWorkspaceSession(workspaceId, fetchAgents),

  listRooms: (workspaceId: string): Promise<RemoteRoomSummary[]> =>
    withWorkspaceSession(workspaceId, fetchRooms),

  listBridges: (workspaceId: string): Promise<RemoteBridge[]> =>
    withReachableWorkspaceSession(workspaceId, async (server) =>
      withResolvedHomeUrls(server, await fetchBridges(server))
    ),

  listBridgeTypes: (workspaceId: string): Promise<RemoteBridgeType[]> =>
    withReachableWorkspaceSession(workspaceId, fetchBridgeTypes),

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
   * Disconnect a messaging app from the chosen workspace. Admin-only, and the
   * gateway deletes every Switch room on the bridge on the way — see
   * `deleteBridge`. The renderer owns the confirmation; by the time this runs
   * the rooms are being given up deliberately.
   */
  deleteBridge: (params: DeleteBridgeParams): Promise<DeleteBridgeResult> =>
    withReachableWorkspaceSession(params.workspaceId, async (server) => {
      // Read before the delete, because afterwards there is no bridge left to
      // read a platform from — and awaited, unlike every other report: left to
      // resolve on its own it would outlive the lease that scopes it to this
      // workspace. A disconnect is a confirmed, destructive action, not a hot
      // path, so it can afford the round trip.
      const platform = await bridgePlatformOnServer(server, params.bridgeId);
      const result = await deleteBridge(server, params.bridgeId);
      trackEvent('bridge_disconnected', {
        bridge_platform: platform,
        outcome: result.kind === 'deleted' ? 'success' : 'failure',
      });
      return result;
    }),

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

  createRoomFromTemplate: (
    workspaceId: string,
    yamlText: string,
    inputs: Record<string, string | number | boolean>,
    templateName?: string
  ): Promise<ProvisionFromTemplateResult> =>
    withWorkspaceSession(workspaceId, (server) =>
      createRoomFromTemplate(server, yamlText, inputs, templateName)
    ),

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

  /** Delete a room and everything in it. The gateway enforces who may. */
  deleteRoom: async (params: { workspaceId: string; roomId: string }): Promise<void> => {
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

    await withWorkspaceSession(params.workspaceId, async (server) => {
      try {
        await deleteRoom(server, params.roomId);
      } catch (error) {
        report('failure');
        throw error;
      }
      report('success');
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

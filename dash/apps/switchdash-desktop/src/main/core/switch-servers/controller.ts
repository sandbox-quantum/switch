import type { Result } from '@switchdash/shared';
import { suggestAgentDefaults } from '@main/core/agents/agent-defaults';
import { knownAgentTypeForProvider } from '@main/core/agents/known-agent-type';
import { propagateServerApiUrl } from '@main/core/agents/propagate-server-api-url';
import { registerAgentIdentity } from '@main/core/agents/register-agent-identity';
import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import { writeRemoteSwitchSettings } from '@main/core/agents/write-remote-switch-settings';
import { writeSwitchSettings } from '@main/core/agents/write-switch-settings';
import { appService } from '@main/core/app/service';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import {
  isManagedServerRunning,
  managedServerHostBlocked,
} from '@main/core/managed-switch-server/managed-server-status';
import { HostUnreachableError } from '@main/core/remote-hosts/host-reachability-service';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type {
  AddressingPolicy,
  AddServerParams,
  AgentDefaults,
  AgentVerifyResult,
  CreateRoomParams,
  CreateRoomResult,
  PasswordLoginParams,
  ProvisionAgentParams,
  ProvisionAgentResult,
  ProvisionRemoteAgentParams,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteExternalUser,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  RenameServerParams,
  ServerConnectionStatus,
  SwitchAuthConfig,
  SwitchServer,
  UpdateServerParams,
  UpdateServerResult,
} from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type LoginError, oidcLogin, passwordLogin } from './auth';
import { createRoomOnServer } from './create-room';
import {
  addRoomAgents,
  agentExistsOnServer,
  fetchAddressingPolicy,
  fetchAgentDetail,
  fetchAgentRooms,
  fetchAgents,
  fetchAllExternalUsers,
  fetchAuthConfig,
  fetchBridges,
  fetchMe,
  fetchRoomAgentIds,
  fetchRoomGroups,
  fetchRoomRoles,
  fetchRooms,
  GatewayError,
  removeRoomAgent,
  updateAddressingPolicy,
} from './gateway-client';
import { openAuthenticatedGatewayPage } from './gateway-web';
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
} from './servers-store';

async function requireServer(serverId: string): Promise<SwitchServer> {
  const server = await getServer(serverId);
  if (!server) {
    throw new Error(`No Switch server with id ${serverId}`);
  }
  return server;
}

/**
 * Resolve a server and refuse to touch its gateway while the host it is managed
 * on is unreachable. Everything the gateway serves — auth config, sign-in,
 * dashboard pages — rides the SSH forward, so a fetch here can only produce a
 * misleading `Could not reach http://localhost:<port>` (CHOO-1780). Fail with
 * the modeled host state instead, which the UI already knows how to render.
 */
async function requireReachableServer(serverId: string): Promise<SwitchServer> {
  const server = await requireServer(serverId);
  const blocked = managedServerHostBlocked(server);
  if (blocked) throw new HostUnreachableError(blocked);
  return server;
}

export const switchServersController = createRPCController({
  listServers: (): Promise<SwitchServer[]> => listServers(),

  addServer: async (params: AddServerParams): Promise<SwitchServer> => {
    const server = await addServer(params);
    await resolveAgentServers();
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

  passwordLogin: async (params: PasswordLoginParams) => {
    const server = await requireReachableServer(params.serverId);
    return passwordLogin(server, params.email, params.password);
  },

  oidcLogin: async (serverId: string): Promise<Result<true, LoginError>> =>
    oidcLogin(await requireReachableServer(serverId)),

  logout: (serverId: string): Promise<void> => deleteSessionCookie(serverId),

  /**
   * Open a gateway web page (operator dashboard). For the managed local server —
   * whose session switchdash owns — this opens an in-app window with the
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

  listRemoteBridges: async (serverId: string): Promise<RemoteBridge[]> =>
    fetchBridges(await requireReachableServer(serverId)),

  /**
   * Create a room on the chosen server, owned by the signed-in user. Room
   * provisioning stays server-side (`POST /gateway/rooms`); this only maps
   * recoverable failures onto a typed result the modal can act on.
   */
  createRoom: async (params: CreateRoomParams): Promise<CreateRoomResult> => {
    const server = await requireReachableServer(params.serverId);
    return createRoomOnServer(server, {
      name: params.name,
      description: params.description,
      instructions: params.instructions,
      bridgeId: params.bridgeId,
      agentIds: params.agentIds,
    });
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

  /**
   * Add agents to a room. Failures propagate as-is: the caller shows the
   * gateway's own words (e.g. an agent whose server-side client is not running,
   * which the gateway rejects) rather than a generic message.
   */
  addRoomAgents: async (params: {
    serverId: string;
    roomId: string;
    agentIds: string[];
  }): Promise<void> =>
    addRoomAgents(await requireReachableServer(params.serverId), params.roomId, params.agentIds),

  /** Remove one agent from a room. Membership only — the agent is not deleted. */
  removeRoomAgent: async (params: {
    serverId: string;
    roomId: string;
    agentId: string;
  }): Promise<void> =>
    removeRoomAgent(await requireReachableServer(params.serverId), params.roomId, params.agentId),

  listRemoteRoomGroups: async (serverId: string): Promise<RemoteRoomGroup[]> =>
    fetchRoomGroups(await requireServer(serverId)),

  listRemoteExternalUsers: async (serverId: string): Promise<RemoteExternalUser[]> =>
    fetchAllExternalUsers(await requireServer(serverId)),

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

    const registered = await registerAgentIdentity(server, {
      name: params.name,
      description: params.description,
      repoDir: params.dir,
      autoSession: params.autoSession,
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
      apiToken: registered.apiKey,
      agentId: registered.id,
    });

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

    const registered = await registerAgentIdentity(server, {
      name: params.name,
      description: params.description,
      repoDir: params.remoteRepoDir,
      autoSession: params.autoSession,
      // Remote provisioning likewise writes `.claude/settings.local.json`.
      agentType: knownAgentTypeForProvider('claude'),
    });
    if (registered.kind !== 'created') return registered;

    const proxy = await ensureSshConnected(sshConnectionIdForHost(params.sshHost), params.sshHost);
    const fs = new SshFileSystem(proxy, params.remoteRepoDir);
    try {
      await writeRemoteSwitchSettings(fs, {
        apiEndpoint: server.apiUrl,
        apiToken: registered.apiKey,
        agentId: registered.id,
      });
    } finally {
      fs.close();
    }

    return { kind: 'created', agentId: registered.id };
  },
});

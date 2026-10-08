import type { Result } from '@switch-console/shared';
import { z } from 'zod';
import { propagateServerApiUrl } from '@main/core/agents/propagate-server-api-url';
import { appService } from '@main/core/app/service';
import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { isManagedServerRunning } from '@main/core/managed-switch-server/managed-server-status';
import type { TelemetryAuthMethod, TelemetrySignInFailure } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { reconcileServerWorkspaces } from '@main/core/workspaces/reconcile-workspaces';
import {
  withReachableServerWorkspaceSession,
  withServerWorkspaceSession,
} from '@main/core/workspaces/workspace-session';
import { listWorkspacesForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import {
  type InviteServer,
  SWITCH_CLOUD_NAME,
  type SwitchCloudEndpoint,
} from '@shared/core/switch-servers/switch-cloud';
import type {
  AddServerParams,
  BundledChatSignIn,
  PasswordLoginParams,
  RenameServerParams,
  ServerConnectionStatus,
  SignupParams,
  SignupResult,
  SwitchAuthConfig,
  SwitchServer,
  UpdateServerParams,
  UpdateServerResult,
} from '@shared/core/switch-servers/switch-servers';
import type { JoinableWorkspaces, PendingInvitations } from '@shared/core/workspaces/invitations';
import { isWithdrawnWorkspace, type Workspace } from '@shared/core/workspaces/workspaces';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type LoginError, oidcLogin, passwordLogin, type SignupError, signup } from './auth';
import { bundledChatSignInFor } from './bundled-chat-sign-in';
import {
  getConnectionCatalog,
  getGitHubConnection,
  fetchAgentIconChoices,
  fetchAvatarSettings,
  cloudMachineLifecycle,
  ensureCloudMachine,
  listCloudMachines,
  disconnectGitHub,
  acceptInvitation,
  acceptPendingInvitation,
  joinWorkspaceByDomain,
  createTenant,
  fetchAuthConfig,
  fetchMe,
  fetchJoinableWorkspaces,
  fetchPendingInvitations,
  GatewayError,
  type RemoteTenant,
} from './gateway-client';
import { openAuthenticatedGatewayPage } from './gateway-web';
import {
  startGitHubBrowserFlow,
  getGitHubBrowserFlow,
  confirmGitHubBrowserFlow,
  cancelGitHubBrowserFlow,
} from './github-browser-flow';
import { deleteManagedClaudeCredential } from './managed-claude-credential';
import { hostUnreachable, requireReachableServer, requireServer } from './require-server';
import {
  addServer,
  deleteSessionCookie,
  findServerByGatewayUrl,
  getServer,
  listServers,
  removeServer,
  renameServer,
  serverKindOf,
  setActiveServerId,
  updateServer,
} from './servers-store';
import { requireSwitchCloudEndpoint, switchCloudEndpoint } from './switch-cloud';

/** A sign-in's own error union, as a reportable code. Never its message. */
const SIGN_IN_FAILURE: Record<LoginError['kind'], TelemetrySignInFailure> = {
  invalid_credentials: 'invalid_credentials',
  cancelled: 'cancelled',
  failed: 'failed',
};

function signInFailureReason(result: Result<unknown, LoginError>): TelemetrySignInFailure {
  return result.success ? 'none' : SIGN_IN_FAILURE[result.error.kind];
}

const SIGNUP_FAILURE: Record<SignupError['kind'], TelemetrySignInFailure> = {
  disabled: 'disabled',
  email_taken: 'email_taken',
  invalid: 'invalid',
  rate_limited: 'rate_limited',
  failed: 'failed',
};

function signupFailureReason(result: Result<unknown, SignupError>): TelemetrySignInFailure {
  return result.success ? 'none' : SIGNUP_FAILURE[result.error.kind];
}

/**
 * Match the server's workspaces to the memberships the account turns out to
 * have. Signing in is the first moment the gateway will answer that, and the
 * renderer reloads its workspace list straight afterwards — so it is awaited,
 * to be there when it does.
 *
 * Logged rather than raised: the sign-in itself succeeded, and reporting it as
 * a failure would send the user back to a form that has nothing left to do.
 */
async function adoptWorkspaces(server: SwitchServer): Promise<void> {
  try {
    await reconcileServerWorkspaces(server.id);
  } catch (error) {
    log.warn('workspaces: signed in, but could not read the account’s workspaces', {
      server: server.id,
      error: String(error),
    });
  }
}

/**
 * Reported by reason rather than by outcome: the two are the same fact, and a
 * sign-in that never left this machine — the server's host is down — has a
 * reason of its own but no result to read one from.
 */
/**
 * The local row for a workspace a server has just added the account to.
 *
 * Reconciled rather than inserted here, the same as `createWorkspace`: which
 * local row a membership belongs to is decided in one place.
 */
async function recordJoined(server: SwitchServer, tenant: RemoteTenant): Promise<Workspace> {
  await reconcileServerWorkspaces(server.id);
  const workspaces = await listWorkspacesForServer(server.id);
  const joined = workspaces.find((workspace) => workspace.tenantId === tenant.id);
  if (!joined) {
    throw new Error(
      `${server.name} added you to ${tenant.name}, but this install did not record it.`
    );
  }
  return joined;
}

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

/**
 * Register Switch Cloud as a server, or hand back the one already registered.
 *
 * Idempotent because the first-run flow walks back and forth over it: going
 * back from sign-in and choosing the Cloud again must land on the same row,
 * and the gateway URL is unique, so a second insert would fail rather than
 * duplicate. Reported only when a row is actually added.
 */
async function registerSwitchCloud({ url }: SwitchCloudEndpoint): Promise<SwitchServer> {
  const existing = await findServerByGatewayUrl(url);
  if (existing) return existing;
  let server: SwitchServer;
  try {
    server = await addServer({ name: SWITCH_CLOUD_NAME, gatewayUrl: url, apiUrl: url });
  } catch (error) {
    trackEvent('server_added', { server_kind: 'external', outcome: 'failure' });
    throw error;
  }
  trackEvent('server_added', { server_kind: 'external', outcome: 'success' });
  return server;
}

export const switchServersController = createRPCController({
  /** The icons the server generates for an agent called `name`, one page at a time. */
  agentIconChoices: (params: { serverId: string; name: string; page: number }) =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      fetchAgentIconChoices(server, params.name, params.page)
    ),
  /** Whether this server allows a third-party avatar URL (DiceBear, ui-avatars.com)
   * to be generated or sent anywhere. */
  avatarSettings: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => fetchAvatarSettings(server)),
  /** The caller's cloud machines, or null when the server offers none. */
  cloudMachines: (serverId: string) =>
    withServerWorkspaceSession(serverId, (server) => listCloudMachines(server)),
  cloudMachineLifecycle: (
    serverId: string,
    machineId: string,
    action: 'stop' | 'start' | 'retry',
    revision: number
  ) =>
    withReachableServerWorkspaceSession(serverId, (server) =>
      cloudMachineLifecycle(
        server,
        machineId,
        z.enum(['stop', 'start', 'retry']).parse(action),
        revision
      )
    ),

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
    return server;
  },

  /** Where Switch Cloud is, or null when this build or run has not been told. */
  switchCloud: async (): Promise<SwitchCloudEndpoint | null> => switchCloudEndpoint(),

  /** Register Switch Cloud as a server, or hand back the one already registered. */
  connectToSwitchCloud: async (): Promise<SwitchServer> =>
    registerSwitchCloud(requireSwitchCloudEndpoint()),

  /**
   * The server an invite link points at, as far as this install can reach it.
   *
   * A server already registered here is handed back as it is. Switch Cloud is
   * registered on the spot when the link is for it, since its addresses are the
   * build's and there is nothing to ask. Any other server is unknown: an invite
   * link names the server's web address and nothing else, and where its agents
   * connect is not something to guess, so the caller has to ask.
   */
  serverForInvite: async (origin: string): Promise<InviteServer> => {
    const cloud = switchCloudEndpoint();
    if (cloud && new URL(cloud.url).origin === new URL(origin).origin) {
      return { kind: 'known', server: await registerSwitchCloud(cloud), via: 'cloud' };
    }
    const existing = await findServerByGatewayUrl(origin);
    if (existing) return { kind: 'known', server: existing, via: 'external' };
    return { kind: 'unknown', origin };
  },

  updateServer: async (params: UpdateServerParams): Promise<UpdateServerResult> => {
    const previous = await requireServer(params.id);
    const server = await updateServer(params);

    // The API URL is what an agent's SWITCH_API_ENDPOINT points at. When it
    // changes, cascade it to every member agent's stored config so they don't
    // keep authenticating against the stale endpoint (CHOO-1431). Compare the
    // saved (normalised) values so a no-op edit doesn't rewrite configs.
    const apiUrlChanged = previous.apiUrl !== server.apiUrl;
    const propagatedAgents = apiUrlChanged
      ? await propagateServerApiUrl(server.id, server.apiUrl)
      : [];
    // The managed agents this computer runs reach the server through its
    // controller, which has to reconnect at the new address too.
    if (apiUrlChanged) await embeddedControllerService.followServerApiUrl(server.id);

    return { server, propagation: { apiUrlChanged, agents: propagatedAgents } };
  },

  renameServer: (params: RenameServerParams): Promise<SwitchServer> => renameServer(params),

  removeServer: async (serverId: string): Promise<void> => {
    // While the session and the workspace rows still exist to revoke it with.
    await embeddedControllerService.forgetServer(serverId);
    await removeServer(serverId);
  },

  getConnectionCatalog: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => getConnectionCatalog(server)),
  getGitHubConnection: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => getGitHubConnection(server)),
  startGitHubConnection: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) =>
      startGitHubBrowserFlow(server, (url) => appService.openExternal(url))
    ),
  getGitHubFlow: (serverId: string, id: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => getGitHubBrowserFlow(server, id)),
  confirmGitHubConnection: (serverId: string, id: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => confirmGitHubBrowserFlow(server, id)),
  cancelGitHubConnection: (serverId: string, id: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => cancelGitHubBrowserFlow(server, id)),
  disconnectGitHub: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => disconnectGitHub(server)),
  openGitHubInstallation: async (serverId: string) => {
    const connection = await withReachableServerWorkspaceSession(serverId, (server) =>
      getGitHubConnection(server)
    );
    if (
      !/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(connection.install_url)
    )
      throw new Error('The server returned an invalid GitHub installation URL.');
    await appService.openExternal(connection.install_url);
  },

  setActiveServer: (serverId: string): Promise<void> => setActiveServerId(serverId),

  /**
   * Ask a server which workspaces this account belongs to, and return the local
   * rows for them.
   *
   * Local rows rather than the gateway's answer directly, because what a caller
   * does next is scope the window to one, and that is addressed by the row's
   * id. Reconciling first is what guarantees there is a row for each.
   *
   * An empty list means the server answered and the account belongs to nothing
   * — a real answer, and the one the first-run flow turns into "create your
   * workspace". A server that cannot be asked raises instead, because the two
   * are not the same and a caller that treated them alike would offer to create
   * a second workspace to someone who already has one.
   */
  resolveWorkspaces: async (serverId: string): Promise<Workspace[]> => {
    await reconcileServerWorkspaces(serverId);
    const workspaces = await listWorkspacesForServer(serverId);
    // A withdrawn membership is a row this install still holds for a workspace
    // the account has been removed from. It is kept so its agents are not
    // silently detached, but it is not somewhere to work: every call scoped to
    // it is refused, and with exactly one of them the caller would take it
    // without asking.
    return workspaces.filter(
      (workspace) => workspace.tenantId !== null && !isWithdrawnWorkspace(workspace)
    );
  },

  /**
   * Create a workspace on a server, owned by the signed-in user.
   *
   * Addressed by server rather than by workspace — the exception the split
   * allows itself, because the thing being created is the workspace: there is
   * no id to address it by until the gateway has minted one, and on a fresh
   * install there is no other workspace to address it from either.
   *
   * Reconciling afterwards rather than inserting a row here keeps one
   * implementation of "which local row is this membership": the new workspace
   * may claim the tenant-less row a freshly registered server starts with, and
   * deciding that twice is how the two answers come to differ. It is also what
   * carries the typed name onto the row, since a matched workspace takes its
   * name from the gateway — so a reconcile that fails here leaves the name to
   * the next one rather than stranding it on the server forever, which is what
   * a rename issued from this call site would have done.
   */
  createWorkspace: async (params: { serverId: string; name: string }): Promise<Workspace> => {
    const server = await requireReachableServer(params.serverId);
    const tenant = await createTenant(server, params.name);
    await reconcileServerWorkspaces(params.serverId);

    const workspaces = await listWorkspacesForServer(params.serverId);
    const created = workspaces.find((workspace) => workspace.tenantId === tenant.id);
    if (!created) {
      throw new Error(
        `${server.name} created the workspace ${tenant.name}, but this install did not record it.`
      );
    }
    return created;
  },

  /**
   * Accept an invitation on a server, and return the local row for the
   * workspace it joined.
   */
  acceptInvitation: async (params: { serverId: string; token: string }): Promise<Workspace> => {
    const server = await requireReachableServer(params.serverId);
    return recordJoined(server, await acceptInvitation(server, params.token));
  },

  /** The invitations waiting for the signed-in account on a server. */
  listPendingInvitations: async (serverId: string): Promise<PendingInvitations> =>
    fetchPendingInvitations(await requireReachableServer(serverId)),

  /**
   * Accept an invitation addressed to the signed-in account, and return the
   * local row for the workspace it joined — the same as `acceptInvitation`,
   * with the account's address in place of the link.
   */
  acceptPendingInvitation: async (params: {
    serverId: string;
    tenantId: string;
    invitationId: string;
  }): Promise<Workspace> => {
    const server = await requireReachableServer(params.serverId);
    return recordJoined(
      server,
      await acceptPendingInvitation(server, params.tenantId, params.invitationId)
    );
  },

  /** The workspaces open to the signed-in account's domain on a server. */
  listJoinableWorkspaces: async (serverId: string): Promise<JoinableWorkspaces> =>
    fetchJoinableWorkspaces(await requireReachableServer(serverId)),

  /**
   * Join a workspace open to the signed-in account's domain, and return the
   * local row for it.
   */
  joinWorkspaceByDomain: async (params: {
    serverId: string;
    tenantId: string;
  }): Promise<Workspace> => {
    const server = await requireReachableServer(params.serverId);
    return recordJoined(server, await joinWorkspaceByDomain(server, params.tenantId));
  },

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
    if (result.success) await adoptWorkspaces(server);
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
    if (result.success) await adoptWorkspaces(server);
    return result;
  },

  signup: async (params: SignupParams): Promise<Result<SignupResult, SignupError>> => {
    const server = await requireServer(params.serverId);
    const unreachable = hostUnreachable(server);
    if (unreachable) {
      reportSignIn('signup', server, 'unreachable');
      throw unreachable;
    }
    const result = await signup(server, {
      email: params.email,
      password: params.password,
      displayName: params.displayName,
    });
    reportSignIn('signup', server, signupFailureReason(result));
    if (result.success) await adoptWorkspaces(server);
    return result;
  },

  ensureCloudMachine: (serverId: string) =>
    withReachableServerWorkspaceSession(serverId, (server) => ensureCloudMachine(server)),

  logout: async (serverId: string): Promise<void> => {
    // Read before the cookie goes, so the kind of server is still knowable — and
    // caught, because nobody should be unable to sign out because of it.
    const server = await getServer(serverId).catch(() => null);
    await deleteManagedClaudeCredential(serverId);
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

  /**
   * The bundled chat's address and sign-in for a managed server (CHOO-1787).
   *
   * The password crosses IPC only when the renderer asks — the card fetches on
   * expand, not on render — so it is not sitting in every server page's memory.
   * Do not log the result.
   */
  getBundledChatSignIn: async (serverId: string): Promise<BundledChatSignIn> =>
    bundledChatSignInFor(await getServer(serverId)),
});

import type { Result } from '@switch-console/shared';
import { suggestAgentDefaults } from '@main/core/agents/agent-defaults';
import { propagateServerApiUrl } from '@main/core/agents/propagate-server-api-url';
import { appService } from '@main/core/app/service';
import { isManagedServerRunning } from '@main/core/managed-switch-server/managed-server-status';
import type { TelemetryAuthMethod, TelemetrySignInFailure } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { reconcileServerWorkspaces } from '@main/core/workspaces/reconcile-workspaces';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type {
  AddServerParams,
  AgentDefaults,
  BundledChatSignIn,
  PasswordLoginParams,
  RenameServerParams,
  ServerConnectionStatus,
  SwitchAuthConfig,
  SwitchServer,
  UpdateServerParams,
  UpdateServerResult,
} from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type LoginError, oidcLogin, passwordLogin } from './auth';
import { bundledChatSignInFor } from './bundled-chat-sign-in';
import { fetchAuthConfig, fetchMe, GatewayError } from './gateway-client';
import { openAuthenticatedGatewayPage } from './gateway-web';
import { hostUnreachable, requireReachableServer, requireServer } from './require-server';
import {
  addServer,
  deleteSessionCookie,
  getServer,
  listServers,
  removeServer,
  renameServer,
  serverKindOf,
  setActiveServerId,
  updateServer,
} from './servers-store';

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
    return server;
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

    return { server, propagation: { apiUrlChanged, agents: propagatedAgents } };
  },

  renameServer: (params: RenameServerParams): Promise<SwitchServer> => renameServer(params),

  removeServer: (serverId: string): Promise<void> => removeServer(serverId),

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

  /**
   * The bundled chat's address and sign-in for a managed server (CHOO-1787).
   *
   * The password crosses IPC only when the renderer asks — the card fetches on
   * expand, not on render — so it is not sitting in every server page's memory.
   * Do not log the result.
   */
  getBundledChatSignIn: async (serverId: string): Promise<BundledChatSignIn> =>
    bundledChatSignInFor(await getServer(serverId)),

  suggestAgentDefaults: async (params: {
    dir: string;
    providerId: AgentProviderId;
  }): Promise<AgentDefaults> => suggestAgentDefaults(params.dir, params.providerId),
});

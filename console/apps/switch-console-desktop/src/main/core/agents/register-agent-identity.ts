import type { KnownAgentType } from '@main/core/agents/known-agent-type';
import {
  fetchAgents,
  GatewayError,
  isGatewayTimeout,
  registerKnownAgent,
} from '@main/core/switch-servers/gateway-client';
import type { RegisterIdentityFailure } from '@shared/core/switch-servers/switch-servers';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

export type RegisterAgentInput = {
  name: string;
  description: string;
  repoDir: string;
  /** Gateway known-agent type; derive from the provider via
   * `knownAgentTypeForProvider`. Required — an omitted type would silently
   * register the agent as Claude Code whatever it actually runs (CHOO-1436). */
  agentType: KnownAgentType;
  /** The icon chosen in the create form, or null for none. Required so a new
   * create flow has to say which it means. */
  iconUrl: string | null;
  /** The human label the agent is rendered under on chat platforms, or null to
   * be shown under `name`. Required for the same reason as `iconUrl`: a flow
   * that has a label to pass must not lose it by omission. */
  displayName: string | null;
};

/**
 * Register a new agent identity on `server` (owned by the signed-in user) and
 * map recoverable gateway failures to a typed {@link ProvisionAgentResult}
 * (unauthorized→unauthenticated, 409→name-conflict, 400→invalid-name, else
 * error). Every Switch Console-managed agent is its own top-level Switch identity —
 * there is no parent/child linkage on the gateway; a Switch Console agent is a flat
 * repository-defined agent (CHOO-1440). Shared by the local and remote create
 * flows so the option mapping stays identical.
 *
 * Channels are always enabled and the agent is always `auto_session`: Switch
 * Console keeps the agent's connection and starts a session whenever it is
 * addressed, whatever the underlying model provider — there is no user-facing
 * "how do you run Claude" choice, and no opting out of automatic sessions.
 */
export async function registerAgentIdentity(
  server: SwitchServer,
  input: RegisterAgentInput
): Promise<{ kind: 'created'; id: string; apiKey: string } | RegisterIdentityFailure> {
  const register = (overwrite: boolean) =>
    registerKnownAgent(server, {
      name: input.name,
      description: input.description,
      agentType: input.agentType,
      iconUrl: input.iconUrl,
      displayName: input.displayName,
      options: {
        channels_enabled: true,
        repo_dir: input.repoDir,
        auto_session: true,
      },
      overwrite,
    });
  const startedAt = Date.now();
  try {
    const registered = await register(false);
    return { kind: 'created', id: registered.id, apiKey: registered.apiKey };
  } catch (cause) {
    // Switch Console stopped waiting, but the server may have registered the
    // agent. One made by this attempt is registered again to get the key
    // whose answer was lost; nothing is reported as failed while it exists.
    if (isGatewayTimeout(cause) && (await madeSince(server, input.name, startedAt))) {
      const registered = await register(true);
      return { kind: 'created', id: registered.id, apiKey: registered.apiKey };
    }
    if (isGatewayTimeout(cause) && cause instanceof GatewayError) {
      return { kind: 'timed-out', message: cause.message };
    }
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 409) return { kind: 'name-conflict' };
      if (cause.kind === 'http' && cause.status === 400) {
        return { kind: 'invalid-name', message: cause.detail ?? cause.message };
      }
      return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/** Leeway for the server's clock against this one when matching an agent to the attempt that made it. */
const CLOCK_LEEWAY_MS = 60_000;

/** Whether the server has an agent named `name` made since `since`: by the attempt that timed out. */
async function madeSince(server: SwitchServer, name: string, since: number): Promise<boolean> {
  const agents = await fetchAgents(server);
  const made = agents.find((agent) => agent.name === name);
  return made !== undefined && Date.parse(made.createdAt) >= since - CLOCK_LEEWAY_MS;
}

import type { AgentProviderKind, ProvisionAgentResult } from '@shared/core/switch-servers/switch-servers';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { GatewayError, registerKnownAgent } from '@main/core/switch-servers/gateway-client';

export type RegisterAgentInput = {
  name: string;
  description: string;
  providerKind: AgentProviderKind;
  repoDir: string;
  notifyUser?: string;
  autoSession?: boolean;
};

/**
 * Register a new agent identity on `server` (owned by the signed-in user) and
 * map recoverable gateway failures to a typed {@link ProvisionAgentResult}
 * (unauthorized→unauthenticated, 409→name-conflict, 400→invalid-name, else
 * error). Every switchdash-managed agent is its own top-level Switch identity —
 * there is no parent/child linkage on the gateway; a switchdash agent is a flat
 * repository-defined agent (CHOO-1440). Shared by the local and remote create
 * flows so the option mapping stays identical.
 */
export async function registerAgentIdentity(
  server: SwitchServer,
  input: RegisterAgentInput
): Promise<
  { kind: 'created'; id: string; apiKey: string } | Exclude<ProvisionAgentResult, { kind: 'created' }>
> {
  try {
    const registered = await registerKnownAgent(server, {
      name: input.name,
      description: input.description,
      options: {
        channels_enabled: input.providerKind === 'anthropic',
        repo_dir: input.repoDir,
        ...(input.autoSession ? { auto_session: true } : {}),
        ...(input.notifyUser ? { notify_user: input.notifyUser } : {}),
      },
    });
    return { kind: 'created', id: registered.id, apiKey: registered.apiKey };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 409) return { kind: 'name-conflict' };
      if (cause.kind === 'http' && cause.status === 400) {
        return { kind: 'invalid-name', message: cause.message };
      }
      return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

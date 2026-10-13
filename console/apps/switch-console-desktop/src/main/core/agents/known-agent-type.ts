import { requireProvider } from '@shared/core/providers/agent-provider-registry';

/**
 * A gateway known-agent type: one `known_agent()` resolves in
 * `switch_core/gateway/known_agents.py`. The gateway rejects any other value at
 * registration. Each provider's comes from its plugin metadata.
 */
export type KnownAgentType = string;

export function knownAgentTypeForProvider(providerId: string): KnownAgentType {
  return requireProvider(providerId).knownAgentType;
}

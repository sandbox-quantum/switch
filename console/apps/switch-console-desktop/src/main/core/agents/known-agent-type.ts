import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * A gateway known-agent type. The union is closed to the keys of `KNOWN_AGENTS`
 * in `switch_core/gateway/known_agents.py` — a value outside it is rejected at
 * registration, so it is worth catching at the call site instead.
 */
export type KnownAgentType = 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'cursor';

const KNOWN_AGENT_TYPE_BY_PROVIDER: Record<AgentProviderId, KnownAgentType> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'antigravity',
  cursor: 'cursor',
};

export function knownAgentTypeForProvider(providerId: AgentProviderId): KnownAgentType {
  return KNOWN_AGENT_TYPE_BY_PROVIDER[providerId];
}

import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * A gateway known-agent type. The union is closed to the keys of `KNOWN_AGENTS`
 * in `switch_core/gateway/known_agents.py` — a value outside it is rejected at
 * registration, so it is worth catching at the call site instead.
 */
export type KnownAgentType = 'claude-code' | 'codex' | 'opencode';

const KNOWN_AGENT_TYPE_BY_PROVIDER: Partial<Record<AgentProviderId, KnownAgentType>> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
};

const FALLBACK_KNOWN_AGENT_TYPE: KnownAgentType = 'claude-code';

/**
 * Map a Switch Console provider to the gateway known-agent type it registers as.
 *
 * A provider outside the server-side types has no faithful representation.
 * It still registers as `claude-code` — the generic Switch Console-managed shape —
 * because Switch Console drives the session itself and the type mainly determines
 * the connector label and the hand-onboarding command an operator is shown. That
 * mismatch is real (an operator onboarding a Gemini agent by hand is told to run
 * `claude`), so it is warned about rather than passed over silently.
 */
export function knownAgentTypeForProvider(providerId: AgentProviderId): KnownAgentType {
  const known = KNOWN_AGENT_TYPE_BY_PROVIDER[providerId];
  if (known) return known;

  log.warn(
    'knownAgentTypeForProvider: provider has no gateway known-agent type; registering as the generic Switch Console-managed shape',
    { providerId, registeringAs: FALLBACK_KNOWN_AGENT_TYPE }
  );
  return FALLBACK_KNOWN_AGENT_TYPE;
}

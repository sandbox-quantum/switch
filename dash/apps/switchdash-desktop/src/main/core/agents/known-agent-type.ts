import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Gateway known-agent types that exist server-side (`KNOWN_AGENTS` in
 * `switch_core/gateway/known_agents.py`). Only these two are real.
 */
const KNOWN_AGENT_TYPE_BY_PROVIDER: Partial<Record<AgentProviderId, string>> = {
  claude: 'claude-code',
  codex: 'codex',
};

const FALLBACK_KNOWN_AGENT_TYPE = 'claude-code';

/**
 * Map a switchdash provider to the gateway known-agent type it registers as.
 *
 * A provider outside the two server-side types has no faithful representation.
 * It still registers as `claude-code` — the generic switchdash-managed shape —
 * because switchdash drives the session itself and the type mainly determines
 * the connector label and the hand-onboarding command an operator is shown. That
 * mismatch is real (an operator onboarding a Gemini agent by hand is told to run
 * `claude`), so it is warned about rather than passed over silently.
 */
export function knownAgentTypeForProvider(providerId: AgentProviderId): string {
  const known = KNOWN_AGENT_TYPE_BY_PROVIDER[providerId];
  if (known) return known;

  log.warn(
    'knownAgentTypeForProvider: provider has no gateway known-agent type; registering as the generic switchdash-managed shape',
    { providerId, registeringAs: FALLBACK_KNOWN_AGENT_TYPE }
  );
  return FALLBACK_KNOWN_AGENT_TYPE;
}

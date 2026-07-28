import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Map a switchdash provider to the gateway known-agent type it registers as.
 * Codex has its own gateway known-agent (correct connector type + `codex …`
 * onboarding command instead of Claude's); every other provider still registers
 * as `claude-code`, the generic switchdash-managed shape (CHOO-1436).
 */
export function knownAgentTypeForProvider(providerId: AgentProviderId): string {
  return providerId === 'codex' ? 'codex' : 'claude-code';
}

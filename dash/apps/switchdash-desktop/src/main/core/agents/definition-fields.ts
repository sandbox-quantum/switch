import type { RepoAgentField } from '@switchdash/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * The editable attribute fields for a provider's agent definitions (e.g. a Claude
 * Code subagent's model / effort / tools / system prompt), in display order, or
 * an empty list when the provider has no definition concept. Drives the "Advanced
 * configuration" section of the add-agent modal (CHOO-1440).
 */
export function getAgentDefinitionFields(providerId: AgentProviderId): RepoAgentField[] {
  return getPlugin(providerId).behavior.repoAgents?.attributeFields() ?? [];
}

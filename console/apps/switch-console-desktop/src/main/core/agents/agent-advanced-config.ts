import type { RepoAgentAttributes, RepoAgentField } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import {
  attributesFromProviderConfig,
  providerConfigFromAttributes,
} from '@shared/core/agents/agent-provider-config';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { readAgentDefinition, updateAgentDefinition } from './agent-definition';
import { getAgentById } from './getAgentById';
import { setAgentProviderConfig } from './setAgentProviderConfig';

/**
 * An agent's "advanced configuration" — its per-agent model, reasoning effort,
 * system prompt and whatever else its provider exposes — read and written
 * without the caller knowing where the provider keeps it.
 *
 * There are two places it can live, and they are not interchangeable:
 * - A **repo-agent definition** on disk (Claude Code: `.claude/agents/<name>.md`),
 *   edited by rewriting the file.
 * - A **launch profile** built at spawn from the agent row (Codex:
 *   `~/.codex/<name>.config.toml`), edited by writing `providerConfig`.
 *
 * Both are per-agent settings collected as the same `RepoAgentField[]` and shown
 * in the same form, so the storage split is an implementation detail rather than
 * two features. A provider with neither has no advanced configuration and the
 * section renders nothing.
 */

/** The fields this provider exposes, from whichever surface it keeps them in. */
export function getAgentAdvancedFields(providerId: AgentProviderId): RepoAgentField[] {
  const behavior = getPlugin(providerId).behavior;
  const definitionFields = behavior.repoAgents?.attributeFields();
  if (definitionFields) return definitionFields;
  return behavior.mcp?.launchProfileFields?.() ?? [];
}

/**
 * Current values for the form, or null when there is nothing stored yet — the
 * caller renders an empty form in that case.
 */
export async function readAgentAdvancedConfig(
  agentId: string
): Promise<RepoAgentAttributes | null> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  if (getPlugin(agent.providerId).behavior.repoAgents) {
    return readAgentDefinition(agentId);
  }
  return attributesFromProviderConfig(agent.providerConfig);
}

/**
 * Save new values. Routed to the provider's own surface: a definition rewrite,
 * or the agent row plus the side effects a profile change needs (see
 * {@link setAgentProviderConfig}).
 */
export async function updateAgentAdvancedConfig(params: {
  agentId: string;
  attributes: RepoAgentAttributes;
}): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);

  const behavior = getPlugin(agent.providerId).behavior;
  if (behavior.repoAgents) {
    return updateAgentDefinition(params);
  }
  if (!behavior.mcp?.launchProfileFields) {
    throw new Error(`Agent ${params.agentId} has no editable advanced configuration.`);
  }
  return setAgentProviderConfig({
    agentId: params.agentId,
    config: providerConfigFromAttributes(params.attributes),
  });
}

import type { RepoAgentAttributes, RepoAgentField } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { readAgentConfig, setAgentSettings } from './agent-config';
import { getAgentById } from './getAgentById';

/**
 * An agent's "advanced configuration" — its per-agent model, reasoning effort,
 * system prompt and whatever else its provider exposes — read and written
 * without the caller knowing where the provider keeps it.
 *
 * All of it is stored in one place — the agent's committed config file — and
 * rendered from there into whatever the provider actually reads: a repo-agent
 * definition on disk (Claude Code: `.claude/agents/<name>.md`), or a launch
 * profile built at spawn (Codex: `~/.codex/<name>.config.toml`). Which of those
 * a provider uses still matters to the caller, because only the second is read
 * once at spawn and so cannot reach a running session, but it is no longer
 * where the values live.
 *
 * A provider with neither has no advanced configuration and the section renders
 * nothing.
 */

/** The fields this provider exposes, from whichever surface it keeps them in. */
export function getAgentAdvancedFields(providerId: AgentProviderId): RepoAgentField[] {
  const behavior = getPlugin(providerId).behavior;
  const definitionFields = behavior.repoAgents?.attributeFields();
  if (definitionFields) return definitionFields;
  return behavior.mcp?.launchProfileFields?.() ?? [];
}

/** Where a provider keeps its per-agent settings. */
export type AgentAdvancedSurface = 'definition' | 'launch-profile' | 'none';

/**
 * Which of the two surfaces a provider uses, for a caller that has to treat them
 * differently — the renderer offers a restart only for a launch profile, which is
 * read once at spawn and so cannot reach a session already running.
 *
 * Reported rather than inferred from the provider id: that check was `=== 'codex'`
 * for as long as Codex was the only provider with a profile, and silently
 * excluded the next one.
 */
export function getAgentAdvancedSurface(providerId: AgentProviderId): AgentAdvancedSurface {
  const behavior = getPlugin(providerId).behavior;
  if (behavior.repoAgents?.attributeFields()) return 'definition';
  if (behavior.mcp?.launchProfileFields) return 'launch-profile';
  return 'none';
}

/**
 * Current values for the form, or null when there is nothing stored yet — the
 * caller renders an empty form in that case.
 */
export async function readAgentAdvancedConfig(
  agentId: string
): Promise<RepoAgentAttributes | null> {
  const config = await readAgentConfig(agentId);
  return config.settings ?? {};
}

/**
 * Save new values into the agent's config file, then regenerate whatever its
 * provider reads — including, for a launch-profile provider, the launch spec a
 * remote agent's sidecar holds. See `setAgentSettings`.
 */
export async function updateAgentAdvancedConfig(params: {
  agentId: string;
  attributes: RepoAgentAttributes;
}): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);

  const behavior = getPlugin(agent.providerId).behavior;
  if (!behavior.repoAgents && !behavior.mcp?.launchProfileFields) {
    throw new Error(`Agent ${params.agentId} has no editable advanced configuration.`);
  }

  await setAgentSettings({ agentId: params.agentId, settings: params.attributes });
}

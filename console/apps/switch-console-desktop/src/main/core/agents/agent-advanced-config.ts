import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { advancedSettings } from '@switch-console/plugins/agents';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentAdvancedSettings } from '@shared/core/agents/agent-advanced-settings';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { readAgentConfig, setAgentSettings } from './agent-config';
import { getAgentById } from './getAgentById';

/**
 * An agent's "advanced configuration" — its per-agent model, reasoning effort
 * and whatever else its provider exposes — read and written without the caller
 * knowing where the provider keeps it.
 *
 * All of it is stored in one place — the agent's committed config file — and
 * turned into whatever the provider takes when a session launches: the agent
 * definition the session runs as (Claude Code), or a launch profile (Codex:
 * `~/.codex/<name>.config.toml`). Either way a change reaches the next session,
 * not one already running.
 *
 * The fields the form shows are the Switch server's, for the agent's provider;
 * the provider's plugin says which of them it applies. A provider with neither
 * surface has no advanced configuration and the section renders nothing.
 */

export function getAgentAdvancedSettings(providerId: AgentProviderId): AgentAdvancedSettings {
  const behavior = getPlugin(providerId).behavior;
  const surface = behavior.repoAgents
    ? 'definition'
    : behavior.mcp?.launchProfileSettings
      ? 'launch-profile'
      : 'none';
  return { surface, keys: Object.keys(advancedSettings(providerId)) };
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
  if (!behavior.repoAgents && !behavior.mcp?.launchProfileSettings) {
    throw new Error(`Agent ${params.agentId} has no editable advanced configuration.`);
  }

  await setAgentSettings({ agentId: params.agentId, settings: params.attributes });
}

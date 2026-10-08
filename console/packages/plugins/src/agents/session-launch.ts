import type {
  CLIAgentPluginProvider,
  RepoAgentAttributes,
  RepoAgentField,
  RepoAgentLaunchDefinition,
  SwitchLaunchSpecialization,
} from '@switch-console/core/agents/plugins';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '../switch-skill';
import { pluginRegistry } from './plugin-registry';

/**
 * How an agent's configuration becomes the provider-specific part of the
 * session it runs: the model and its options, the agent definition Claude Code
 * runs as, the Codex profile, and the system context. Shared by Console, for
 * its own agents, and by the agent controller, for managed ones, so an agent
 * configured the same way runs the same way under either.
 */

/** One value of an agent's advanced configuration, shaped by its field's `type`. */
export type AdvancedConfigValue = string | number | boolean | string[];

/** An agent's advanced configuration, keyed by its provider's field keys; unset fields are absent. */
export type AdvancedConfig = Record<string, AdvancedConfigValue>;

/** Fields that are the agent's main attributes, collected outside its advanced configuration. */
const MAIN_ATTRIBUTE_KEYS = new Set(['name', 'description', 'model', 'instructions']);

function pluginFor(provider: string): CLIAgentPluginProvider {
  const plugin = pluginRegistry.get(provider);
  if (!plugin) throw new Error(`No plugin found for provider: ${provider}`);
  return plugin;
}

/**
 * The advanced configuration fields a provider offers: the ones Console's
 * advanced configuration form renders for it, from whichever surface the
 * provider keeps them in, without the agent's main attributes. Empty for a
 * provider with none.
 */
export function advancedConfigFields(provider: string): RepoAgentField[] {
  const behavior = pluginFor(provider).behavior;
  const fields =
    behavior.repoAgents?.attributeFields() ?? behavior.mcp?.launchProfileFields?.() ?? [];
  return fields.filter((field) => !MAIN_ATTRIBUTE_KEYS.has(field.key));
}

function valueFits(field: RepoAgentField, value: AdvancedConfigValue): boolean {
  switch (field.type) {
    case 'list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'select':
      return (
        typeof value === 'string' &&
        value !== '' &&
        (field.options ?? []).some((option) => option.value === value)
      );
    case 'text':
    case 'textarea':
      return typeof value === 'string';
  }
}

/**
 * What is wrong with an advanced configuration for a provider, naming the
 * field, or null when every field is one the provider offers and holds a value
 * of its type. A select's unset choice ("") is not a value: an unset field is
 * left out.
 */
export function advancedConfigProblem(provider: string, config: AdvancedConfig): string | null {
  const fields = new Map(advancedConfigFields(provider).map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(config)) {
    const field = fields.get(key);
    if (!field) return `The advanced configuration field '${key}' is not one ${provider} offers.`;
    if (!valueFits(field, value))
      return `The advanced configuration field '${key}' does not hold a valid ${field.type} value.`;
  }
  return null;
}

/** What a session of an agent is launched from, before any of it is placed in a session. */
export type AgentLaunchSources = {
  /**
   * The values a provider's launch profile is built from: the agent's settings
   * as strings plus its instructions, under the canonical key every provider
   * renders. Undefined when it sets none.
   */
  specialization: SwitchLaunchSpecialization | undefined;
  /** For a provider that runs a session as a named agent, the definition it runs as. */
  definition: RepoAgentLaunchDefinition | undefined;
};

/**
 * The launch sources of an agent, from its configuration. `settings` holds the
 * agent's field values, its model among them; `description` and
 * `instructions` are empty when unset.
 */
export function agentLaunchSources(input: {
  provider: string;
  name: string;
  description: string;
  settings: RepoAgentAttributes;
  instructions: string;
}): AgentLaunchSources {
  const repoAgents = pluginFor(input.provider).behavior.repoAgents;
  return {
    specialization: launchSpecialization(input.settings, input.instructions),
    definition:
      repoAgents && definesAgent(input)
        ? repoAgents.launchDefinition({
            ...input.settings,
            name: input.name,
            description: input.description || input.name,
            instructions: input.instructions,
          })
        : undefined,
  };
}

/**
 * Whether the configuration says anything a definition would carry. One that
 * says nothing runs the provider as it is, rather than as a definition whose
 * prompt is its own name.
 */
function definesAgent(input: {
  description: string;
  settings: RepoAgentAttributes;
  instructions: string;
}): boolean {
  return !!input.description || !!input.instructions || Object.keys(input.settings).length > 0;
}

function launchSpecialization(
  settings: RepoAgentAttributes,
  instructions: string
): SwitchLaunchSpecialization | undefined {
  const specialization: SwitchLaunchSpecialization = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text.trim() === '') continue;
    specialization[key] = text;
  }
  if (instructions) specialization.instructions = instructions;
  return Object.keys(specialization).length > 0 ? specialization : undefined;
}

/** The provider-specific part of a session's configuration. */
export type SessionLaunch = {
  /** The model the session runs, with the provider's option for it; undefined for the provider's default. */
  model: { id: string; options?: Record<string, string> } | undefined;
  /** The named agent the session runs as, with its definition; undefined to run the provider as it is. */
  agent: { name: string; definition: RepoAgentLaunchDefinition } | undefined;
  /** The Codex profile's TOML; empty for other providers and for a Codex agent on its defaults. */
  codexConfig: string;
  /** The Switch skill as a file, for a provider that loads skills itself; empty otherwise. */
  skill: string;
  /** The system context: the Switch skill for a provider that takes it that way, then the instructions. */
  context: string;
  /** The agent's own instructions, alone. */
  instructions: string;
};

/**
 * The provider-specific part of a session's configuration, from the agent's
 * launch sources. `slug` names the agent the session runs as; `cwd` is its
 * working directory on the machine that runs it.
 */
export function sessionLaunchFrom(input: {
  provider: string;
  slug: string;
  cwd: string;
  sources: AgentLaunchSources;
}): SessionLaunch {
  const { provider, slug } = input;
  const specialization = input.sources.specialization ?? {};
  const profile =
    provider === 'codex'
      ? pluginFor(provider).behavior.mcp?.launchProfile?.({
          slug,
          workingDir: input.cwd,
          values: specialization,
        })
      : undefined;
  const optionKey = provider === 'opencode' ? 'variant' : 'effort';
  const optionValue = specialization[optionKey];
  return {
    model: specialization.model
      ? {
          id: specialization.model,
          ...(optionValue ? { options: { [optionKey]: optionValue } } : {}),
        }
      : undefined,
    agent: input.sources.definition
      ? { name: slug, definition: input.sources.definition }
      : undefined,
    codexConfig: profile?.files.map((file) => file.content).join('\n') ?? '',
    // OpenCode loads the skill as a file through its own skill tool; the
    // others take it as system context. Codex has no skill tool, so a skill
    // file would be read with a shell command that needs approval.
    skill: provider === 'opencode' ? SWITCH_SKILL_FILE : '',
    context: [provider === 'opencode' ? '' : SWITCH_SKILL_CONTEXT, specialization.instructions]
      .filter(Boolean)
      .join('\n\n'),
    instructions: specialization.instructions ?? '',
  };
}

/**
 * The provider-specific part of the configuration of a session an agent runs:
 * the agent named `slug`, working in `cwd`, on `model` (null for the
 * provider's default) with its advanced configuration and instructions.
 */
export function sessionLaunchConfig(input: {
  provider: string;
  slug: string;
  description: string;
  cwd: string;
  model: string | null;
  advancedConfig: AdvancedConfig;
  instructions: string;
}): SessionLaunch {
  return sessionLaunchFrom({
    provider: input.provider,
    slug: input.slug,
    cwd: input.cwd,
    sources: agentLaunchSources({
      provider: input.provider,
      name: input.slug,
      description: input.description,
      settings: { ...input.advancedConfig, ...(input.model ? { model: input.model } : {}) },
      instructions: input.instructions,
    }),
  });
}

import { isDeepStrictEqual } from 'node:util';
import type {
  RepoAgentField,
  RepoAgentLaunchDefinition,
} from '@switch-console/core/agents/plugins';
import {
  type AdvancedConfig,
  type AdvancedConfigValue,
  advancedConfigFields,
  sessionLaunchConfig,
} from '@switch-console/plugins/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * The v1 managed agent definition, as Switch's agent management takes it
 * (`DefinitionV1` in Core). It has no field for anything else, so whatever
 * else an agent's Console configuration says is listed rather than dropped
 * silently.
 */
export type ManagedDefinition = {
  provider: AgentProviderId;
  model: string | null;
  /** The provider's advanced configuration, keyed by its field keys; unset fields are absent. */
  advanced_config: AdvancedConfig;
  instructions: string;
  auto_approve: boolean;
  directory: string | null;
};

/** The longest instructions Core takes (`MAX_INSTRUCTIONS_BYTES`). */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

/** Refuses instructions longer than Core takes. */
export function assertInstructionsFit(instructions: string): void {
  if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES)
    throw new Error(
      `The instructions are longer than the ${MAX_INSTRUCTIONS_BYTES / 1024} KiB a managed agent takes; shorten them before moving it.`
    );
}

/** The specialisation keys the definition carries as top-level fields. */
const TOP_LEVEL_KEYS = new Set(['model', 'instructions']);

/** A specialisation value (always a string) as the value its field takes, or null when it is not one. */
function fieldValue(field: RepoAgentField, text: string): AdvancedConfigValue | null {
  switch (field.type) {
    case 'list': {
      const items = text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length > 0 ? items : null;
    }
    case 'number': {
      const value = Number(text);
      return text.trim() !== '' && Number.isFinite(value) ? value : null;
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : null;
    case 'select':
      return text !== '' && (field.options ?? []).some((option) => option.value === text)
        ? text
        : null;
    case 'text':
    case 'textarea':
      return text;
  }
}

/**
 * The advanced configuration an agent's launch specialisation amounts to, for
 * the provider's fields, and what of it has no managed equivalent, said for a
 * person.
 */
export function advancedConfigFromSpecialization(
  providerId: AgentProviderId,
  specialization: Record<string, string | undefined>
): { advancedConfig: AdvancedConfig; notCarried: string[] } {
  const fields = new Map(advancedConfigFields(providerId).map((field) => [field.key, field]));
  const advancedConfig: AdvancedConfig = {};
  const unknown: string[] = [];
  const notCarried: string[] = [];
  for (const key of Object.keys(specialization).sort()) {
    const text = specialization[key];
    if (!text || TOP_LEVEL_KEYS.has(key)) continue;
    const field = fields.get(key);
    if (!field) {
      unknown.push(key);
      continue;
    }
    const value = fieldValue(field, text);
    if (value === null)
      notCarried.push(`The setting ${field.label} (“${text}”): it is not a value the field takes.`);
    else advancedConfig[key] = value;
  }
  if (unknown.length)
    notCarried.unshift(
      `Launch settings with no managed equivalent: ${unknown.join(', ')}${providerId === 'codex' ? ' (Codex launch profile)' : ''}.`
    );
  return { advancedConfig, notCarried };
}

export type DefinitionSource = {
  providerId: AgentProviderId;
  /** The name the managed agent runs under. */
  name: string;
  /** The agent's launch specialisation (`agentLaunchConfig`), or undefined when it sets none. */
  specialization: Record<string, string | undefined> | undefined;
  /** The provider agent definition the agent launches as (Claude Code's `--agent`), if any. */
  providerDefinition: RepoAgentLaunchDefinition | undefined;
  autoApprove: boolean;
  /** The agent's working directory, as an absolute path on its machine; null for a workspace the machine chooses. */
  directory: string | null;
  /** Somebody stopped the agent's watcher by hand: it moves stopped, and stays stopped. */
  stoppedByHand: boolean;
  /** A shell setup the location runs before each session. */
  shellSetup: boolean;
  /** The provider CLI Console was told to use, when it is not simply the one on PATH. */
  chosenBinary: string | null;
};

export type BuiltDefinition = {
  definition: ManagedDefinition;
  desiredState: 'running' | 'stopped';
  /** What the managed agent will not have, said for a person. */
  notCarried: string[];
};

/**
 * The managed definition an agent's Console configuration amounts to, and
 * what it leaves behind. Pure.
 *
 * The advanced configuration is the agent's own settings, which its machine's
 * controller applies as Console does.
 *
 * A managed agent always starts a session when addressed. One whose watcher
 * was stopped by hand moves as the desired state `stopped`.
 */
export function buildManagedDefinition(source: DefinitionSource): BuiltDefinition {
  const specialization = source.specialization ?? {};
  const { advancedConfig, notCarried } = advancedConfigFromSpecialization(
    source.providerId,
    specialization
  );
  if (source.shellSetup)
    notCarried.push('The location’s shell setup: managed sessions start without running it first.');
  if (source.chosenBinary)
    notCarried.push(
      `The provider CLI chosen in Console (${source.chosenBinary}): the managed agent uses the one on the machine's PATH.`
    );
  const instructions = specialization.instructions ?? '';
  assertInstructionsFit(instructions);
  const model = specialization.model || null;
  if (source.providerDefinition) {
    const managed = sessionLaunchConfig({
      provider: source.providerId,
      slug: source.name,
      description: '',
      cwd: source.directory ?? '',
      model,
      advancedConfig,
      instructions,
    }).agent?.definition;
    const differing = [
      ...new Set([...Object.keys(source.providerDefinition), ...Object.keys(managed ?? {})]),
    ]
      .filter((key) => !isDeepStrictEqual(source.providerDefinition?.[key], managed?.[key]))
      .sort();
    if (differing.length)
      notCarried.push(
        `Part of the provider agent definition this agent launches as (${differing.join(', ')}): the managed agent's definition is built from its name, model, advanced configuration and instructions alone.`
      );
  }
  return {
    definition: {
      provider: source.providerId,
      model,
      advanced_config: advancedConfig,
      instructions,
      auto_approve: source.autoApprove,
      directory: source.directory,
    },
    desiredState: source.stoppedByHand ? 'stopped' : 'running',
    notCarried,
  };
}

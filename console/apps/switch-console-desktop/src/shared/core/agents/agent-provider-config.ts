import type {
  RepoAgentAttributes,
  SwitchLaunchSpecialization,
} from '@switch-console/core/agents/plugins';
import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

/**
 * Per-agent, provider-specific launch configuration. Today this carries the
 * Codex specialization folded into the agent's Codex profile at launch — model,
 * reasoning effort, verbosity, reasoning summary, web search, and a
 * system-prompt/instructions body.
 *
 * Every field is optional and an unset one is omitted from the profile, leaving
 * the provider's own configuration to decide. That is deliberate for the on/off
 * settings too: `webSearch` unset is not `webSearch` off — the first defers to
 * the user's `~/.codex/config.toml`, the second overrides it. That is why it is
 * a string rather than a boolean, since a boolean has no "unset".
 *
 * Stored as a versioned JSON column on the agent so the shape can evolve without
 * a migration per field, mirroring `sessions.config`. New fields are added as
 * optional to the current version: a row written before they existed simply has
 * none of them.
 */
const agentProviderConfigV1 = z.object({
  version: z.literal('1'),
  /** Provider model id, e.g. a Codex `model` override. */
  model: z.string().optional(),
  /** Reasoning-effort id, e.g. a Codex `model_reasoning_effort` value. */
  effort: z.string().optional(),
  /** How much prose the model writes, e.g. Codex `model_verbosity`. */
  verbosity: z.string().optional(),
  /** How much reasoning is summarised back, e.g. Codex `model_reasoning_summary`. */
  reasoningSummary: z.string().optional(),
  /** `"true"` / `"false"` / unset — e.g. Codex `tools.web_search`. */
  webSearch: z.string().optional(),
  /** System-prompt/instructions body, carried in the agent's Codex profile as
   * `developer_instructions` — additive to Codex's own instructions. */
  instructions: z.string().optional(),
});

export const agentProviderConfig = defineVersionedSchema()
  .initial('1', agentProviderConfigV1)
  .build();

export type AgentProviderConfig = typeof agentProviderConfig.Type;

/** The stored keys, which are also the field keys the provider declares. */
const CONFIG_KEYS = [
  'model',
  'effort',
  'verbosity',
  'reasoningSummary',
  'webSearch',
  'instructions',
] as const;

const clean = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
};

/**
 * Map stored per-agent config to the launch-time specialization the profile
 * builder consumes. Empty/whitespace values are dropped so the profile omits
 * them and the base default stands. Returns `undefined` when nothing is set, so
 * callers pass no specialization at all.
 */
export function toSwitchSpecialization(
  config: AgentProviderConfig | null | undefined
): SwitchLaunchSpecialization | undefined {
  if (!config) return undefined;

  const specialization: SwitchLaunchSpecialization = {};
  for (const key of CONFIG_KEYS) {
    const value = clean(config[key]);
    if (value !== undefined) specialization[key] = value;
  }

  return Object.keys(specialization).length > 0 ? specialization : undefined;
}

/** Seed the advanced-configuration form from an agent's stored config. */
export function attributesFromProviderConfig(
  config: AgentProviderConfig | null | undefined
): RepoAgentAttributes {
  const attributes: RepoAgentAttributes = {};
  for (const key of CONFIG_KEYS) attributes[key] = config?.[key] ?? '';
  return attributes;
}

/**
 * Build the stored config from submitted form attributes. Null when every field
 * is blank: an agent that specializes nothing gets no profile and no `--profile`
 * argv, rather than an empty one.
 */
export function providerConfigFromAttributes(
  attributes: RepoAgentAttributes
): AgentProviderConfig | null {
  const config: AgentProviderConfig = { version: '1' };
  let set = false;
  for (const key of CONFIG_KEYS) {
    const value = clean(attributes[key]);
    if (value === undefined) continue;
    config[key] = value;
    set = true;
  }
  return set ? config : null;
}

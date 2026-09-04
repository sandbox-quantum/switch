import type {
  RepoAgentAttributes,
  SwitchLaunchSpecialization,
} from '@switch-console/core/agents/plugins';
import z from 'zod';
import type { SessionRuntimeKind } from '@shared/core/sessions/session-transcript';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

/**
 * Per-agent, provider-specific launch configuration: the values folded into the
 * agent's launch profile at spawn.
 *
 * The keys are whatever the provider declares in `mcp.launchProfileFields()`, so
 * this schema does not name them. Two providers do not agree on what a per-agent
 * setting even is — Codex has a reasoning-effort enum, a verbosity and a
 * reasoning summary; OpenCode has none of those, and instead has a model-specific
 * variant, a temperature, a top-p and a step cap. A fixed field list would be one
 * provider's vocabulary imposed on the rest, growing a column of mostly-blank
 * slots with every provider added.
 *
 * Every value is a string and an unset one is omitted, leaving the provider's own
 * configuration to decide. That is deliberate for the on/off settings too: web
 * search unset is not web search off — the first defers to the user's base
 * config, the second overrides it. That is why such a setting is collected as a
 * select with a blank choice rather than a checkbox, which has no "unset".
 *
 * Stored as a versioned JSON column on the agent so the shape can evolve without
 * a migration per change, mirroring `sessions.config`.
 */
const agentProviderConfigV2 = z.object({
  version: z.literal('2'),
  /**
   * How this agent's sessions drive their agent: through the provider's own
   * SDK/protocol (`provider`) or by typing into a TUI in tmux (`pty`). Absent
   * means `pty`, which is what every agent written before this did.
   *
   * A sibling of {@link agentProviderConfigV2.values} rather than a key inside
   * it: `values` is the provider's own launch-profile vocabulary, and this is
   * Switch Console's choice of how to run the thing at all.
   */
  runtime: z.enum(['pty', 'provider']).optional(),
  /**
   * The provider whose field keys {@link values} are named for. Recorded so a row
   * is readable on its own and so the v1 upgrade can state what it assumed, not
   * to gate reading: a profile writer only consumes the keys it declares, so a
   * key it does not know is ignored either way.
   */
  providerId: z.string(),
  /** Field key → value, as declared by that provider's `launchProfileFields()`. */
  values: z.record(z.string(), z.string()),
});

/**
 * The original shape: Codex's six settings as named columns.
 *
 * Kept so stored rows still parse. Only Codex ever declared launch-profile
 * fields, so every v1 row is a Codex specialization — which is what the upgrade
 * below relies on.
 */
const agentProviderConfigV1 = z.object({
  version: z.literal('1'),
  model: z.string().optional(),
  effort: z.string().optional(),
  verbosity: z.string().optional(),
  reasoningSummary: z.string().optional(),
  webSearch: z.string().optional(),
  instructions: z.string().optional(),
});

/** The keys version 1 stored, in the order Codex declares them. */
const V1_KEYS = [
  'model',
  'effort',
  'verbosity',
  'reasoningSummary',
  'webSearch',
  'instructions',
] as const;

/**
 * Normalise a collected form value to the stored string form, or `undefined` for
 * "not set".
 *
 * Number fields arrive as numbers (or `null` when blank) and on/off fields as
 * strings, so this coerces rather than requiring a string. `NaN` is dropped
 * rather than stored as `"NaN"`: an unparseable number is not a setting.
 */
const clean = (value: unknown): string | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
};

export const agentProviderConfig = defineVersionedSchema()
  .initial('1', agentProviderConfigV1)
  .version('2', agentProviderConfigV2, (v1) => ({
    version: '2' as const,
    // Codex is the only provider that could have written a v1 row.
    providerId: 'codex',
    values: Object.fromEntries(
      V1_KEYS.map((key) => [key, clean(v1[key])]).filter(([, value]) => value !== undefined)
    ) as Record<string, string>,
  }))
  .build();

export type AgentProviderConfig = typeof agentProviderConfig.Type;

/**
 * Providers that can be driven through a `@switch-console/agent-providers`
 * adapter rather than by typing into a TUI.
 *
 * Shared rather than duplicated per side: the renderer decides whether to offer
 * the toggle and the main process decides whether to honour it, and a list that
 * disagreed between them would show a switch that silently does nothing (or
 * hide one that already works). `provider-adapter-registry` reads the same list.
 */
const PROVIDER_RUNTIME_PROVIDERS: readonly string[] = ['opencode', 'claude'];

/** Whether this provider has an adapter behind it. */
export function supportsProviderRuntime(providerId: string | null | undefined): boolean {
  return providerId !== null && providerId !== undefined
    ? PROVIDER_RUNTIME_PROVIDERS.includes(providerId)
    : false;
}

/**
 * The key the runtime choice is collected under.
 *
 * It travels with the provider's launch-profile attributes because that is the
 * one record the advanced-configuration form reads and writes as a whole; it is
 * lifted out of them below, so it is stored as its own field rather than as a
 * setting the provider never declared.
 */
export const RUNTIME_ATTRIBUTE = 'runtime';

/**
 * How an agent's sessions should be driven. `pty` unless the agent explicitly
 * opted in, so an agent nobody has configured keeps the behaviour it had.
 *
 * `values` is consulted as well as the field: the attribute is what the form
 * collects, and a row written before the lift below existed carries it there.
 */
export function agentRuntimeKind(
  config: AgentProviderConfig | null | undefined
): SessionRuntimeKind {
  if (config?.runtime === 'provider') return 'provider';
  return config?.values?.[RUNTIME_ATTRIBUTE] === 'provider' ? 'provider' : 'pty';
}

/**
 * Map stored per-agent config to the launch-time specialization the profile
 * builder consumes. Returns `undefined` when nothing is set, so callers pass no
 * specialization at all and the agent gets no profile.
 */
export function toSwitchSpecialization(
  config: AgentProviderConfig | null | undefined
): SwitchLaunchSpecialization | undefined {
  if (!config) return undefined;

  const specialization: SwitchLaunchSpecialization = {};
  // `values` is defaulted rather than assumed: outside dev the versioned schema
  // trusts what was stored instead of re-validating it, so a row written by a
  // future version is a launch that should carry no specialization, not one that
  // throws on the way to spawning the agent.
  for (const [key, value] of Object.entries(config.values ?? {})) {
    const cleaned = clean(value);
    if (cleaned !== undefined) specialization[key] = cleaned;
  }

  return Object.keys(specialization).length > 0 ? specialization : undefined;
}

/**
 * Seed the advanced-configuration form from an agent's stored config. Only the
 * stored keys are returned; the form fills the rest from the provider's declared
 * fields, so a setting added after the row was written shows as blank rather
 * than missing.
 */
export function attributesFromProviderConfig(
  config: AgentProviderConfig | null | undefined
): RepoAgentAttributes {
  const attributes: RepoAgentAttributes = {};
  for (const [key, value] of Object.entries(config?.values ?? {})) attributes[key] = value;
  // Put the runtime back where the form expects to find it, so a toggle seeded
  // from a stored row shows what the row actually says.
  if (config?.runtime === 'provider') attributes[RUNTIME_ATTRIBUTE] = config.runtime;
  return attributes;
}

/**
 * Build the stored config from submitted form attributes. Null when every field
 * is blank: an agent that specializes nothing gets no profile at all, rather than
 * an empty one and the argv or environment that would load it.
 */
export function providerConfigFromAttributes(
  providerId: string,
  attributes: RepoAgentAttributes
): AgentProviderConfig | null {
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(attributes)) {
    const value = clean(raw);
    if (value !== undefined) values[key] = value;
  }
  // Lifted out of `values` rather than left in it: `values` is the provider's
  // own launch-profile vocabulary, which the profile writer iterates, and this
  // is Switch Console's choice of how to run the agent at all. The attributes
  // are the whole picture — an absent key means the toggle is off, so nothing
  // here is carried over from a previous row.
  const runtime = values[RUNTIME_ATTRIBUTE] === 'provider' ? ('provider' as const) : undefined;
  delete values[RUNTIME_ATTRIBUTE];
  // A `provider` runtime is itself a setting, so a row is still worth writing
  // for an agent that specializes nothing else — otherwise the opt-in would be
  // dropped on save.
  if (Object.keys(values).length === 0 && runtime === undefined) return null;
  return { version: '2', providerId, values, ...(runtime ? { runtime } : {}) };
}

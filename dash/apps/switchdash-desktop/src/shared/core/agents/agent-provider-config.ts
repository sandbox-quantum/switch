import type { SwitchLaunchSpecialization } from '@switchdash/core/agents/plugins';
import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

/**
 * Per-agent, provider-specific launch configuration. Today this carries the
 * Codex specialization folded into the agent's Codex profile at launch — model,
 * reasoning effort, and a system-prompt/instructions body. Every field is
 * optional; an unset field leaves the provider/base-config default in place.
 *
 * Stored as a versioned JSON column on the agent so the shape can evolve without
 * a migration per field, mirroring `sessions.config`.
 */
const agentProviderConfigV1 = z.object({
  version: z.literal('1'),
  /** Provider model id, e.g. a Codex `model` override. */
  model: z.string().optional(),
  /** Reasoning-effort id, e.g. a Codex `model_reasoning_effort` value. */
  effort: z.string().optional(),
  /** System-prompt/instructions body, written to the agent's instructions file. */
  instructions: z.string().optional(),
});

export const agentProviderConfig = defineVersionedSchema()
  .initial('1', agentProviderConfigV1)
  .build();

export type AgentProviderConfig = typeof agentProviderConfig.Type;

/**
 * Map stored per-agent config to the launch-time specialization the profile
 * builder consumes. `effort` becomes `reasoningEffort`; empty/whitespace values
 * are dropped so the profile omits them and the base default stands. Returns
 * `undefined` when nothing is set, so callers pass no specialization at all.
 */
export function toSwitchSpecialization(
  config: AgentProviderConfig | null | undefined
): SwitchLaunchSpecialization | undefined {
  if (!config) return undefined;

  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  const specialization: SwitchLaunchSpecialization = {
    model: clean(config.model),
    reasoningEffort: clean(config.effort),
    instructions: clean(config.instructions),
  };

  if (!specialization.model && !specialization.reasoningEffort && !specialization.instructions) {
    return undefined;
  }
  return specialization;
}

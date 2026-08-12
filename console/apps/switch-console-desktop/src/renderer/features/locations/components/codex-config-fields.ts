import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { attributesFromForm, type FormState } from './agent-definition-fields';

/**
 * Per-agent Codex configuration: the fields, and the mapping between the form
 * state and the stored {@link AgentProviderConfig}.
 *
 * Codex has no repo-agent definition surface, so these values live on the agent
 * row instead of an on-disk definition, and Switch Console folds them into the
 * agent's Codex profile at launch. They are declared once here because two
 * screens collect them — the add-agent modal and the agent's Settings tab — and
 * a duplicated list would drift the first time Codex gains an effort level.
 *
 * Effort levels mirror `CODEX_REASONING_EFFORTS` in the codex plugin — kept small
 * and stable there, duplicated here so the renderer needs no plugin import.
 * Model is free text because the Codex model catalog changes over time; blank
 * fields leave the user's base `~/.codex/config.toml` default in place.
 */
export const CODEX_CONFIG_FIELDS: RepoAgentField[] = [
  {
    key: 'model',
    label: 'Model',
    type: 'text',
    placeholder: 'e.g. gpt-5.6-terra — blank uses the Codex default',
    help: 'Overrides the model for this agent only.',
  },
  {
    key: 'effort',
    label: 'Reasoning effort',
    type: 'select',
    options: [
      { value: '', label: 'Default' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ],
  },
  {
    key: 'instructions',
    label: 'Instructions',
    type: 'textarea',
    placeholder: "A system prompt for this agent, e.g. 'You are a careful reviewer…'",
    help: "Added to Codex's own instructions as extra developer guidance. Blank keeps Codex defaults.",
  },
];

/**
 * Assemble the stored config from the form, or null when every field is blank —
 * an agent that specializes nothing gets no profile and no `--profile` argv.
 */
export function codexConfigFromForm(state: FormState): AgentProviderConfig | null {
  const attrs = attributesFromForm(CODEX_CONFIG_FIELDS, state);
  const str = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : undefined;
  };
  const model = str(attrs.model);
  const effort = str(attrs.effort);
  const instructions = str(attrs.instructions);
  if (!model && !effort && !instructions) return null;
  return { version: '1', model, effort, instructions };
}

/** Seed the form from an agent's stored config (for editing an existing agent). */
export function codexFormFromConfig(config: AgentProviderConfig | null): FormState {
  return {
    model: config?.model ?? '',
    effort: config?.effort ?? '',
    instructions: config?.instructions ?? '',
  };
}

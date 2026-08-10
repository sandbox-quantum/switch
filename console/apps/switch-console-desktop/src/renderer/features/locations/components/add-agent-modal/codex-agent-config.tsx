import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import {
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';

/**
 * Per-agent Codex configuration for the add-agent modal. Codex has no repo-agent
 * definition surface (so {@link AgentAdvancedConfig} renders nothing for it);
 * instead Switch Console folds these values into the agent's Codex profile at launch.
 *
 * Effort levels mirror `CODEX_REASONING_EFFORTS` in the codex plugin — kept small
 * and stable there, duplicated here so the renderer needs no plugin import.
 * Model is free text because the Codex model catalog changes over time; blank
 * fields leave the user's base `~/.codex/config.toml` default in place.
 */
const CODEX_CONFIG_FIELDS: RepoAgentField[] = [
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

function toProviderConfig(state: FormState): AgentProviderConfig | null {
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

/**
 * Collapsed "Codex configuration" section. Reports the assembled per-agent
 * provider config (or null when nothing is set) so the modal can pass it to
 * `addAgent`, which persists it on the agent and folds it into the launch profile.
 */
export function CodexAgentConfig({
  onChange,
}: {
  onChange: (config: AgentProviderConfig | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FormState>(() => emptyForm(CODEX_CONFIG_FIELDS));

  useEffect(() => {
    onChange(toProviderConfig(state));
  }, [state, onChange]);

  const setField = useCallback((key: string, value: FormValue) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-2 text-sm text-foreground-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        Codex configuration
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
          {CODEX_CONFIG_FIELDS.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`codex-config-${field.key}`}>
                {field.label} (optional)
              </FieldLabel>
              <DefinitionFieldInput
                field={field}
                value={state[field.key] ?? ''}
                onChange={(value) => setField(field.key, value)}
              />
              {field.help && (
                <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
              )}
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}

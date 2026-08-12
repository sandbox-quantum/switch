import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import {
  DefinitionFieldInput,
  emptyForm,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';
import { CODEX_CONFIG_FIELDS, codexConfigFromForm } from '../codex-config-fields';

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
    onChange(codexConfigFromForm(state));
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

import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import {
  type AgentProviderConfig,
  providerConfigFromAttributes,
} from '@shared/core/agents/agent-provider-config';
import {
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';

/**
 * Collapsed "Codex configuration" section. Reports the assembled per-agent
 * provider config (or null when nothing is set) so the modal can pass it to
 * `addAgent`, which persists it on the agent and folds it into the launch profile.
 *
 * The fields are the same ones the agent's Settings tab edits after creation —
 * fetched over RPC from the codex plugin, so the two forms cannot drift.
 */
export function CodexAgentConfig({
  onChange,
}: {
  onChange: (config: AgentProviderConfig | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['agentAdvancedFields', 'codex'],
    queryFn: () => rpc.agents.advancedFields({ providerId: 'codex' }),
  });
  const fields = useMemo(() => data ?? [], [data]);

  const [state, setState] = useState<FormState>({});
  useEffect(() => {
    setState(emptyForm(fields));
  }, [fields]);

  useEffect(() => {
    onChange(providerConfigFromAttributes(attributesFromForm(fields, state)));
  }, [fields, state, onChange]);

  const setField = useCallback((key: string, value: FormValue) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  if (fields.length === 0) return null;

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
          {fields.map((field) => (
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

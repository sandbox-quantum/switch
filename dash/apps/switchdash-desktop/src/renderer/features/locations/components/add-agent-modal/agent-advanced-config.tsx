import type { SubagentAttributes } from '@switchdash/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  advancedFields,
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';

/**
 * Collapsed "Advanced configuration" section for the add-agent modal. Renders the
 * provider's definition attribute fields (model, effort, tools, system prompt, …)
 * beyond name/description, and reports the assembled attributes so the modal can
 * pass them to `addAgent`, which writes them into the agent's on-disk definition.
 * Collapsed by default so ordinary users are not overwhelmed (CHOO-1440).
 */
export function AgentAdvancedConfig({
  providerId,
  onChange,
}: {
  providerId: AgentProviderId | null;
  onChange: (attributes: SubagentAttributes) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: allFields } = useQuery({
    queryKey: ['agentDefinitionFields', providerId],
    queryFn: () => (providerId ? rpc.agents.definitionFields({ providerId }) : Promise.resolve([])),
    enabled: !!providerId,
  });

  const fields = useMemo(() => advancedFields(allFields ?? []), [allFields]);

  const [state, setState] = useState<FormState>({});
  // Reset the form (and reported attributes) whenever the provider's field set
  // changes, so switching agent type does not carry stale values. `onChange` is a
  // stable callback from the modal, so including it does not re-run this.
  useEffect(() => {
    const initial = emptyForm(fields);
    setState(initial);
    onChange(attributesFromForm(fields, initial));
  }, [fields, onChange]);

  if (!providerId || fields.length === 0) return null;

  const setField = (key: string, value: FormValue) => {
    setState((prev) => {
      const next = { ...prev, [key]: value };
      onChange(attributesFromForm(fields, next));
      return next;
    });
  };

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-2 text-sm text-foreground-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        Advanced configuration
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
          {fields.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                {field.label}
                {field.required || field.type === 'boolean' ? '' : ' (optional)'}
              </FieldLabel>
              <DefinitionFieldInput
                field={field}
                value={state[field.key] ?? (field.type === 'boolean' ? false : '')}
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

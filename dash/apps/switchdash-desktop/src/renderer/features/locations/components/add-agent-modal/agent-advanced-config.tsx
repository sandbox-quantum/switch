import type { SubagentAttributes, SubagentField } from '@switchdash/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/** Sentinel for a select's "unset" choice (an empty string is not a valid item). */
const UNSET = '__unset__';

/** A field's value as held in the form: strings for everything except booleans. */
type FormValue = string | boolean;
type FormState = Record<string, FormValue>;

/** name/description are collected as top-level modal fields, not advanced ones. */
const TOP_LEVEL_KEYS = new Set(['name', 'description']);

function emptyForm(fields: SubagentField[]): FormState {
  const state: FormState = {};
  for (const field of fields) state[field.key] = field.type === 'boolean' ? false : '';
  return state;
}

function attributesFromForm(fields: SubagentField[], state: FormState): SubagentAttributes {
  const attributes: SubagentAttributes = {};
  for (const field of fields) {
    const value = state[field.key];
    if (field.type === 'boolean') {
      attributes[field.key] = value === true;
    } else if (field.type === 'list') {
      attributes[field.key] = String(value)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    } else if (field.type === 'number') {
      const trimmed = String(value).trim();
      attributes[field.key] = trimmed.length > 0 ? Number(trimmed) : null;
    } else {
      attributes[field.key] = String(value).trim();
    }
  }
  return attributes;
}

function DefinitionFieldInput({
  field,
  value,
  onChange,
}: {
  field: SubagentField;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  const id = `agent-advanced-${field.key}`;
  if (field.type === 'boolean') {
    return <Switch id={id} checked={value === true} onCheckedChange={onChange} />;
  }
  if (field.type === 'textarea') {
    return (
      <Textarea
        id={id}
        value={String(value)}
        rows={5}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'select') {
    const current = String(value);
    return (
      <Select
        value={current.length > 0 ? current : UNSET}
        onValueChange={(next) => onChange(next === UNSET ? '' : (next ?? ''))}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value.length > 0 ? option.value : UNSET}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      id={id}
      type={field.type === 'number' ? 'number' : 'text'}
      value={String(value)}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

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

  const fields = useMemo(
    () => (allFields ?? []).filter((f) => !TOP_LEVEL_KEYS.has(f.key)),
    [allFields]
  );

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

import type {
  RepoAgentAttributes,
  RepoAgentAttributeValue,
  RepoAgentField,
} from '@switchdash/core/agents/plugins';
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

/** Sentinel for a select's "unset" choice (an empty string is not a valid item). */
const UNSET = '__unset__';

/** A field's value as held in the form: strings for everything except booleans. */
export type FormValue = string | boolean;
export type FormState = Record<string, FormValue>;

/** name/description are collected as top-level fields, not advanced ones. */
export const TOP_LEVEL_KEYS = new Set(['name', 'description']);

/** The advanced (non top-level) attribute fields, in provider display order. */
export function advancedFields(allFields: RepoAgentField[]): RepoAgentField[] {
  return allFields.filter((f) => !TOP_LEVEL_KEYS.has(f.key));
}

export function emptyForm(fields: RepoAgentField[]): FormState {
  const state: FormState = {};
  for (const field of fields) state[field.key] = field.type === 'boolean' ? false : '';
  return state;
}

/** Seed a form from existing attribute values (for editing an existing agent). */
export function formFromAttributes(
  fields: RepoAgentField[],
  attributes: RepoAgentAttributes
): FormState {
  const state: FormState = {};
  for (const field of fields) {
    const value: RepoAgentAttributeValue | undefined = attributes[field.key];
    if (field.type === 'boolean') {
      state[field.key] = value === true;
    } else if (field.type === 'list') {
      state[field.key] = Array.isArray(value) ? value.join(', ') : '';
    } else if (value === null || value === undefined) {
      state[field.key] = '';
    } else {
      state[field.key] = String(value);
    }
  }
  return state;
}

export function attributesFromForm(
  fields: RepoAgentField[],
  state: FormState
): RepoAgentAttributes {
  const attributes: RepoAgentAttributes = {};
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

/** One provider-declared definition attribute, rendered by its field type. */
export function DefinitionFieldInput({
  field,
  value,
  onChange,
}: {
  field: RepoAgentField;
  value: FormValue;
  onChange: (value: FormValue) => void;
}) {
  const id = `agent-definition-${field.key}`;
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
    const selected = current.length > 0 ? current : UNSET;
    const options = field.options ?? [];
    const selectedLabel =
      options.find((o) => (o.value.length > 0 ? o.value : UNSET) === selected)?.label ?? '';
    return (
      <Select
        value={selected}
        onValueChange={(next) => onChange(next === UNSET ? '' : (next ?? ''))}
      >
        <SelectTrigger id={id}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
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

import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import { useState } from 'react';
import {
  DefinitionFieldInput,
  type FormState,
  type FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import {
  fieldCatalogueState,
  fieldWithCatalogue,
  type ModelCatalogueResult,
} from '@renderer/features/locations/components/agent-model-catalogue';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';

/**
 * An agent page's "Advanced configuration": a collapsed row saying what is set,
 * opening onto one input per field, with the model fields checked against what
 * the agent's host offers. Whoever renders it owns the values and saving them.
 */
export function AdvancedConfigDisclosure({
  fields,
  form,
  summary,
  catalogue,
  intro,
  onFieldChange,
  children,
}: {
  fields: RepoAgentField[];
  form: FormState;
  /** What the saved values are, for the collapsed row; see {@link summariseValues}. */
  summary: string;
  catalogue: ModelCatalogueResult | undefined;
  intro: React.ReactNode;
  onFieldChange: (key: string, value: FormValue) => void;
  /** Below the fields, such as a notice about sessions running on the old values. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DisclosureRow
        open={open}
        title="Advanced configuration"
        summary={summary}
        meta={`${fields.length} ${fields.length === 1 ? 'setting' : 'settings'}`}
        onToggle={() => setOpen((v) => !v)}
      />
      <div className={cn('flex flex-col gap-4 pt-3', !open && 'hidden')}>
        <FieldDescription className="text-foreground-muted">{intro}</FieldDescription>
        {fields.map((field) => {
          const catalogueState = fieldCatalogueState(field, form, catalogue);
          const rendered = fieldWithCatalogue(field, catalogueState);
          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                {field.label}
                {field.required || field.type === 'boolean' ? '' : ' (optional)'}
              </FieldLabel>
              <DefinitionFieldInput
                field={rendered}
                value={form[field.key] ?? (field.type === 'boolean' ? false : '')}
                disabled={catalogueState.disabled}
                suggestions={catalogueState.suggestions}
                onChange={(value) => onFieldChange(field.key, value)}
              />
              {field.help && (
                <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
              )}
              {catalogueState.note && (
                <FieldDescription
                  className={
                    catalogueState.warning ? 'text-foreground-warning' : 'text-foreground-muted'
                  }
                >
                  {catalogueState.note}
                </FieldDescription>
              )}
            </Field>
          );
        })}
        {children}
      </div>
    </div>
  );
}

/**
 * What the section is holding, read off the saved values rather than the form —
 * a collapsed row has to say what is set without being opened, and the form may
 * be mid-edit.
 *
 * Values, not labels: "claude-opus-4-6 · high" reads as configuration where
 * "Model claude-opus-4-6 · Reasoning effort high" reads as a table of contents.
 */
export function summariseValues(
  fields: { key: string; label: string }[],
  saved: FormState
): string {
  const set = fields
    .map((field) => {
      const value = saved[field.key];
      if (value === true) return field.label.toLowerCase();
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      return null;
    })
    .filter((v): v is string => v !== null);

  if (set.length === 0) return 'defaults';
  const shown = set.slice(0, 2).join(' · ');
  return set.length > 2 ? `${shown} · +${set.length - 2}` : shown;
}

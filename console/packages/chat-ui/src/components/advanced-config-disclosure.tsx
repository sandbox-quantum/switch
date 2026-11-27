import { useState, type ReactNode } from 'react';
import { cn } from '../model/cn';
import { DisclosureRow } from '../primitives/disclosure-row';
import { Field, FieldDescription, FieldLabel } from '../primitives/field';

/** A field of the section, as it labels it. */
export type AdvancedConfigDisclosureField = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  help?: string | null;
};

/**
 * An agent page's "Advanced configuration": a collapsed row saying what is set,
 * opening onto one input per field. Each field's input, and what is said under
 * it about the models the agent's host offers, are the app's; whoever renders
 * it owns the values and saving them.
 */
export function AdvancedConfigDisclosure<F extends AdvancedConfigDisclosureField>({
  fields,
  summary,
  intro,
  renderField,
  children,
}: {
  fields: F[];
  /** What the saved values are, for the collapsed row; see {@link summariseValues}. */
  summary: string;
  intro: ReactNode;
  /** The field's input, and a note under it, shown as a warning or not; null for none. */
  renderField: (field: F) => {
    input: ReactNode;
    note: { text: string; warning: boolean } | null;
  };
  /** Below the fields, such as a notice about sessions running on the old values. */
  children?: ReactNode;
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
          const { input, note } = renderField(field);
          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                {field.label}
                {field.required || field.type === 'boolean' ? '' : ' (optional)'}
              </FieldLabel>
              {input}
              {field.help && (
                <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
              )}
              {note && (
                <FieldDescription
                  className={note.warning ? 'text-foreground-warning' : 'text-foreground-muted'}
                >
                  {note.text}
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
  saved: Record<string, string | boolean | undefined>
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

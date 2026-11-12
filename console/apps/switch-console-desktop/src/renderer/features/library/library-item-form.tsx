import { useId, useState } from 'react';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { LibraryKind, ReferenceTypeOption } from '@shared/core/switch-servers/library';
import type { LibraryForm } from './library-form';
import { LIBRARY_ACCESS_OPTIONS } from './library-model';

/**
 * The fields of a reference or a document, for creating one and for editing
 * it in place. A reference's type is chosen once: the server does not change it.
 */
export function LibraryItemFields({
  kind,
  form,
  onChange,
  types,
  typeLocked = false,
  canChangeAccess = true,
  autoFocus = false,
  onNewType = null,
}: {
  kind: LibraryKind;
  form: LibraryForm;
  onChange: (next: LibraryForm) => void;
  /** The types a new reference may take; unused for a document. */
  types: readonly ReferenceTypeOption[];
  typeLocked?: boolean;
  canChangeAccess?: boolean;
  autoFocus?: boolean;
  /** Makes a new type to pick, where the type is still being chosen. */
  onNewType?: (() => void) | null;
}) {
  const id = useId();
  const set = (patch: Partial<LibraryForm>) => onChange({ ...form, ...patch });
  const type = types.find((t) => t.type === form.type) ?? null;
  return (
    <FieldGroup>
      {kind === 'references' && (
        <Field>
          <FieldLabel htmlFor={`${id}-type`}>Type</FieldLabel>
          {typeLocked ? (
            <p className="text-sm text-foreground">{type?.displayName ?? form.type}</p>
          ) : (
            <Select value={form.type || null} onValueChange={(next) => set({ type: String(next) })}>
              <SelectTrigger id={`${id}-type`} aria-label="Type" className="w-full">
                <SelectValue>
                  {/* A type just made shows by its slug until the list has it. */}
                  {type ? type.displayName : form.type || 'Pick a type'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.type} value={t.type}>
                    {t.displayName}
                    {!t.isBuiltin && t.ownerName && (
                      <span className="text-foreground-muted"> · by {t.ownerName}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!typeLocked && onNewType && (
            <button
              type="button"
              className="w-max cursor-pointer self-start text-left text-xs text-foreground-muted underline-offset-2 hover:text-foreground hover:underline"
              onClick={onNewType}
            >
              None fit? New type…
            </button>
          )}
        </Field>
      )}
      {kind === 'references' && (
        <Field>
          <FieldLabel htmlFor={`${id}-urls`}>Links</FieldLabel>
          <Textarea
            id={`${id}-urls`}
            value={form.urlsText}
            onChange={(e) => set({ urlsText: e.target.value })}
            placeholder="https://… (one per line)"
            className="min-h-20 font-mono text-xs md:text-xs"
          />
          <p className="text-xs text-foreground-muted">{type?.valueHint || 'One link per line.'}</p>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <Input
          id={`${id}-name`}
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          autoFocus={autoFocus && kind === 'documents'}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-description`}>
          Description <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <Input
          id={`${id}-description`}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="What it is, in a line"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-instructions`}>
          Instructions for agents <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <Textarea
          id={`${id}-instructions`}
          value={form.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="When to use it, and anything to watch out for"
          className="min-h-16"
        />
      </Field>
      {kind === 'documents' && (
        <DocumentContentField
          value={form.content}
          onChange={(content) => set({ content })}
          inputId={`${id}-content`}
        />
      )}
      {canChangeAccess && (
        <Field>
          <FieldLabel>Who can see it</FieldLabel>
          <div className="flex">
            <SegmentedControl
              value={form.access}
              onChange={(access) => set({ access })}
              options={LIBRARY_ACCESS_OPTIONS}
              ariaLabel="Who can see it"
            />
          </div>
          <p className="text-xs text-foreground-muted">
            {LIBRARY_ACCESS_OPTIONS.find((o) => o.value === form.access)?.hint}
          </p>
        </Field>
      )}
    </FieldGroup>
  );
}

const CONTENT_MODES = [
  { value: 'write', label: 'Write' },
  { value: 'preview', label: 'Preview' },
] as const;

/** A document's markdown, written in plain text and previewed as it will read. */
export function DocumentContentField({
  value,
  onChange,
  inputId,
}: {
  value: string;
  onChange: (next: string) => void;
  inputId: string;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={inputId}>Content</FieldLabel>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={CONTENT_MODES}
          ariaLabel="Write or preview the content"
        />
      </div>
      {mode === 'write' ? (
        <Textarea
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Markdown"
          className="max-h-[45vh] min-h-48 font-mono text-xs md:text-xs"
        />
      ) : (
        <div className="max-h-[45vh] min-h-48 overflow-y-auto rounded-md border border-border px-3 py-2">
          {value.trim() ? (
            <MarkdownRenderer content={value} variant="compact" />
          ) : (
            <p className="text-sm text-foreground-muted italic">Nothing written yet.</p>
          )}
        </div>
      )}
    </Field>
  );
}

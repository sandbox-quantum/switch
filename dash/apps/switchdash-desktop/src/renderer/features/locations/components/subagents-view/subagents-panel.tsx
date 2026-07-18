import type { SubagentAttributes, SubagentField } from '@switchdash/core/agents/plugins';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { asMounted, getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { log } from '@renderer/utils/logger';
import type { Subagent } from '@shared/core/subagents/subagents';

/** Subagent name rule: tokenises as a single `@`-mention and is a valid file stem. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Sentinel for a select's "unset" choice, since an empty string isn't a valid
 * Select item value. */
const UNSET = '__unset__';

function validateName(name: string, existing: string[]): string | null {
  if (name.length === 0) return 'Enter a name.';
  if (!NAME_PATTERN.test(name)) {
    return 'Use lowercase letters, digits, and . _ - (must start with a letter or digit).';
  }
  if (existing.includes(name)) return `A subagent named "${name}" already exists.`;
  return null;
}

/** A field's value as held in the form: strings for everything except booleans. */
type FormValue = string | boolean;
type FormState = Record<string, FormValue>;

function emptyForm(fields: SubagentField[]): FormState {
  const state: FormState = {};
  for (const field of fields) state[field.key] = field.type === 'boolean' ? false : '';
  return state;
}

function formFromAttributes(fields: SubagentField[], attributes: SubagentAttributes): FormState {
  const state: FormState = {};
  for (const field of fields) {
    const value = attributes[field.key];
    if (field.type === 'boolean') {
      state[field.key] = value === true;
    } else if (field.type === 'list') {
      state[field.key] = Array.isArray(value) ? value.join(', ') : '';
    } else {
      state[field.key] = value === null || value === undefined ? '' : String(value);
    }
  }
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

/**
 * The "Subagents" tab for an agent that supports them: lists the agent's
 * subagents and lets you create, edit, and delete them directly. Gated upstream
 * by the provider's subagents capability, and by the parent being linked to a
 * Switch server (creating/deleting touches the gateway).
 */
export const SubagentsPanel = observer(function SubagentsPanel() {
  const {
    params: { locationId },
  } = useParams('location');
  const mounted = asMounted(getLocationStore(locationId));

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['project-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const parent = (agents ?? []).find((a) => a.serverId && a.switchAgentId) ?? null;

  const subagentsQuery = useQuery({
    queryKey: ['subagents', parent?.id],
    queryFn: () => rpc.subagents.list(parent!.id),
    enabled: !!parent,
  });

  if (!mounted || agentsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (!parent) {
    return (
      <Field>
        <FieldTitle>Subagents</FieldTitle>
        <FieldDescription className="text-foreground-muted">
          Link this agent to a Switch server first — subagents are registered as child agents on the
          gateway, so the parent needs a Switch identity before you can create them.
        </FieldDescription>
      </Field>
    );
  }

  const subagents = subagentsQuery.data?.subagents ?? [];

  return (
    <SubagentsList
      providerId={parent.providerId}
      parentAgentId={parent.id}
      subagents={subagents}
      loading={subagentsQuery.isLoading}
    />
  );
});

type FormMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; subagent: Subagent };

function SubagentsList({
  providerId,
  parentAgentId,
  subagents,
  loading,
}: {
  providerId: string;
  parentAgentId: string;
  subagents: Subagent[];
  loading: boolean;
}) {
  const [mode, setMode] = useState<FormMode>({ kind: 'list' });

  if (mode.kind === 'create' || mode.kind === 'edit') {
    return (
      <SubagentForm
        providerId={providerId}
        parentAgentId={parentAgentId}
        existingNames={subagents.map((s) => s.name)}
        editingName={mode.kind === 'edit' ? mode.subagent.name : null}
        onDone={() => setMode({ kind: 'list' })}
      />
    );
  }

  return (
    <Field>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <FieldTitle>Subagents</FieldTitle>
          <FieldDescription className="text-foreground-muted">
            Child agents this agent can launch, each with its own Switch identity. Create one to
            register it on the gateway and make it immediately launchable.
          </FieldDescription>
        </div>
        <Button size="sm" onClick={() => setMode({ kind: 'create' })}>
          <Plus />
          Create subagent
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : subagents.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-foreground-muted">
          No subagents yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {subagents.map((subagent) => (
            <SubagentRow
              key={subagent.name}
              parentAgentId={parentAgentId}
              subagent={subagent}
              onEdit={() => setMode({ kind: 'edit', subagent })}
            />
          ))}
        </div>
      )}
    </Field>
  );
}

function SubagentRow({
  parentAgentId,
  subagent,
  onEdit,
}: {
  parentAgentId: string;
  subagent: Subagent;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () =>
      rpc.subagents.delete({
        parentAgentId,
        name: subagent.name,
        switchAgentId: subagent.switchAgentId,
      }),
    onSuccess: () => {
      toast({ title: `Deleted subagent ${subagent.name}` });
      // Prefix match: refresh every subagent list (this panel and the sidebar,
      // which key their queries on different agent ids).
      void queryClient.invalidateQueries({ queryKey: ['subagents'] });
    },
    onError: (error) => {
      log.error('Failed to delete subagent', { name: subagent.name, error });
      toast({
        title: 'Failed to delete subagent',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
      setConfirmingDelete(false);
    },
  });

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{subagent.name}</span>
          {subagent.model && (
            <span className="shrink-0 rounded bg-background-2 px-1 text-[10px] text-foreground-muted">
              {subagent.model}
            </span>
          )}
          {subagent.registered === false && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400">
                    local
                  </span>
                }
              />
              <TooltipContent>
                Discovered locally but not registered on the Switch server.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {subagent.description && (
          <span className="truncate text-xs text-foreground-muted">{subagent.description}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {confirmingDelete ? (
          <>
            <Button
              size="xs"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="outline" onClick={onEdit}>
              Edit
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SubagentForm({
  providerId,
  parentAgentId,
  existingNames,
  editingName,
  onDone,
}: {
  providerId: string;
  parentAgentId: string;
  existingNames: string[];
  editingName: string | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const fieldsQuery = useQuery({
    queryKey: ['subagent-fields', providerId],
    queryFn: () => rpc.subagents.attributeFields(providerId),
  });

  const prefillQuery = useQuery({
    queryKey: ['subagent-definition', parentAgentId, editingName],
    queryFn: () => rpc.subagents.readDefinition({ parentAgentId, name: editingName! }),
    enabled: !!editingName,
  });

  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  const loading = fieldsQuery.isLoading || (!!editingName && prefillQuery.isLoading);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <SubagentFormFields
      fields={fields}
      initial={
        editingName && prefillQuery.data
          ? formFromAttributes(fields, prefillQuery.data)
          : emptyForm(fields)
      }
      editingName={editingName}
      existingNames={existingNames}
      submit={async (attributes) => {
        if (editingName) {
          await rpc.subagents.edit({ parentAgentId, attributes });
        } else {
          await rpc.subagents.create({ parentAgentId, attributes });
        }
      }}
      onSaved={(name) => {
        toast({ title: editingName ? `Updated ${name}` : `Created subagent ${name}` });
        // Prefix match: refresh every subagent list (this panel and the sidebar,
        // which key their queries on different agent ids).
        void queryClient.invalidateQueries({ queryKey: ['subagents'] });
        onDone();
      }}
      onError={(error) => {
        log.error('Failed to save subagent', { editingName, error });
        toast({
          title: editingName ? 'Failed to update subagent' : 'Failed to create subagent',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      }}
      onCancel={onDone}
    />
  );
}

function SubagentFormFields({
  fields,
  initial,
  editingName,
  existingNames,
  submit,
  onSaved,
  onError,
  onCancel,
}: {
  fields: SubagentField[];
  initial: FormState;
  editingName: string | null;
  existingNames: string[];
  submit: (attributes: SubagentAttributes) => Promise<void>;
  onSaved: (name: string) => void;
  onError: (error: unknown) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<FormState>(initial);
  const setField = (key: string, value: FormValue) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const name = String(state.name ?? '').trim();
  const description = String(state.description ?? '').trim();
  // The name is immutable on edit, so don't re-validate it against siblings.
  const nameError = editingName ? null : validateName(name, existingNames);
  const canSubmit = description.length > 0 && (editingName ? true : !nameError);

  const mutation = useMutation({
    mutationFn: () => submit(attributesFromForm(fields, state)),
    onSuccess: () => onSaved(name),
    onError,
  });

  return (
    <div className="flex flex-col gap-5">
      <FieldTitle>{editingName ? `Edit ${editingName}` : 'Create subagent'}</FieldTitle>

      {fields.map((field) => {
        const disabled = mutation.isPending || (!!editingName && field.immutableOnEdit === true);
        const showNameError = field.key === 'name' && !editingName && name.length > 0 && nameError;

        return (
          <Field key={field.key}>
            <FieldLabel htmlFor={`subagent-${field.key}`}>
              {field.label}
              {field.required ? '' : field.type === 'boolean' ? '' : ' (optional)'}
            </FieldLabel>
            <SubagentFieldInput
              field={field}
              value={state[field.key]}
              disabled={disabled}
              onChange={(value) => setField(field.key, value)}
            />
            {showNameError ? (
              <FieldDescription className="text-destructive">{nameError}</FieldDescription>
            ) : (
              field.help && (
                <FieldDescription className="text-foreground-muted">{field.help}</FieldDescription>
              )
            )}
          </Field>
        );
      })}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={mutation.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? 'Saving…' : editingName ? 'Save changes' : 'Create subagent'}
        </Button>
      </div>
    </div>
  );
}

function SubagentFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SubagentField;
  value: FormValue;
  disabled: boolean;
  onChange: (value: FormValue) => void;
}) {
  const id = `subagent-${field.key}`;

  if (field.type === 'boolean') {
    return (
      <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} />
    );
  }

  if (field.type === 'textarea') {
    return (
      <Textarea
        id={id}
        value={String(value)}
        rows={5}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (field.type === 'select') {
    const current = String(value);
    return (
      <Select
        value={current.length > 0 ? current : UNSET}
        disabled={disabled}
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
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

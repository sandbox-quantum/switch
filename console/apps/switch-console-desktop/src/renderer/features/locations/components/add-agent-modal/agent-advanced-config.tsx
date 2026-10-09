import type { RepoAgentAttributes, RepoAgentField } from '@switch-console/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { getProvider } from '@shared/core/providers/agent-provider-registry';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  advancedFields,
  attributesFromForm,
  DefinitionFieldInput,
  formFromAttributes,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';
import { fieldCatalogueState, type ModelCatalogueResult } from '../agent-model-catalogue';

/**
 * Collapsed "Advanced configuration" section for the add-agent modal. Renders the
 * provider's definition attribute fields (model, effort, tools, system prompt, …)
 * beyond name/description, and reports the assembled attributes so the modal can
 * pass them to `addAgent`, which writes them into the agent's on-disk definition.
 * Collapsed by default so ordinary users are not overwhelmed (CHOO-1440).
 */
export function AgentAdvancedConfig({
  providerId,
  sshHost,
  dir,
  initial,
  onChange,
}: {
  providerId: AgentProviderId | null;
  sshHost: string | null;
  dir: string;
  /** The attributes the form starts from; pass a stable value, a new one resets the form. */
  initial: RepoAgentAttributes;
  onChange: (attributes: RepoAgentAttributes) => void;
}) {
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, sshHost ?? 'local', dir],
    queryFn: () => rpc.agents.modelCatalogue({ providerId: providerId!, sshHost, dir }),
    enabled: !!providerId && !!dir.trim(),
    staleTime: 60000,
  });
  const executionCatalogue = dir.trim()
    ? catalogue
    : {
        kind: 'unavailable' as const,
        reason: 'No execution directory is configured yet. You can enter a model alias or ID.',
      };
  const { data: allFields } = useQuery({
    queryKey: ['agentDefinitionFields', providerId],
    queryFn: () => (providerId ? rpc.agents.definitionFields({ providerId }) : Promise.resolve([])),
    enabled: !!providerId,
  });

  const fields = useMemo(() => advancedFields(allFields ?? []), [allFields]);
  const providerLabel = providerId ? (getProvider(providerId)?.name ?? providerId) : null;

  const [state, setState] = useState<FormState>({});
  // Reset the form (and reported attributes) whenever the provider's field set
  // changes, so switching agent type does not carry stale values. `onChange` is a
  // stable callback from the modal, so including it does not re-run this.
  useEffect(() => {
    const form = formFromAttributes(fields, initial);
    setState(form);
    onChange(attributesFromForm(fields, form));
  }, [fields, initial, onChange]);

  if (!providerId || fields.length === 0) return null;

  const setField = (key: string, value: FormValue) => {
    setState((prev) => {
      const next = { ...prev, [key]: value };
      onChange(attributesFromForm(fields, next));
      return next;
    });
  };

  return (
    <AdvancedConfigSection
      providerLabel={providerLabel}
      fields={fields}
      form={state}
      catalogue={executionCatalogue}
      onFieldChange={setField}
    />
  );
}

/**
 * The collapsed section itself, whatever supplies its fields: the provider's own
 * definition fields for an agent this Console runs, the server's schema for a
 * managed one.
 */
export function AdvancedConfigSection({
  providerLabel,
  fields,
  form,
  catalogue,
  onFieldChange,
}: {
  providerLabel: string | null;
  fields: RepoAgentField[];
  form: FormState;
  catalogue: ModelCatalogueResult | undefined;
  onFieldChange: (key: string, value: FormValue) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DisclosureRow
        open={open}
        title="Advanced configuration"
        meta={
          providerLabel
            ? `${providerLabel} · ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`
            : undefined
        }
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="flex flex-col gap-4 pt-3">
          {fields.map((field) => {
            const catalogueState = fieldCatalogueState(field, form, catalogue);
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={`agent-advanced-${field.key}`}>
                  {field.label}
                  {field.required || field.type === 'boolean' ? '' : ' (optional)'}
                </FieldLabel>
                <DefinitionFieldInput
                  suggestions={catalogueState.suggestions}
                  field={field}
                  value={form[field.key] ?? (field.type === 'boolean' ? false : '')}
                  onChange={(value) => onFieldChange(field.key, value)}
                />
                {catalogueState.note && <FieldDescription>{catalogueState.note}</FieldDescription>}
                {field.help && (
                  <FieldDescription className="text-foreground-muted">
                    {field.help}
                  </FieldDescription>
                )}
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}

import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import {
  type AgentProviderConfig,
  providerConfigFromAttributes,
} from '@shared/core/agents/agent-provider-config';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  attributesFromForm,
  DefinitionFieldInput,
  emptyForm,
  type FormState,
  type FormValue,
} from '../agent-definition-fields';
import {
  fieldCatalogueState,
  fieldWithCatalogue,
  type ModelCatalogueResult,
} from '../agent-model-catalogue';
import { useLocalAdvancedFields } from '../use-local-advanced-fields';
import { AdvancedConfigProblem } from './agent-advanced-config';

/**
 * Collapsed "Advanced configuration" section for a provider that keeps its
 * per-agent settings in a launch profile (Codex, OpenCode). Reports the assembled
 * per-agent provider config (or null when nothing is set) so the modal can pass
 * it to `addAgent`, which persists it on the agent and folds it into the profile.
 *
 * The fields are the same ones the agent's Settings tab edits after creation:
 * the model and the agent's Switch server's fields for the provider, so the two
 * forms cannot drift. Only one of the two surfaces — this or the agent
 * definition `AgentAdvancedConfig` renders — exists per provider, and this one
 * renders nothing for the other; for a provider with neither it renders only
 * a problem with the server's fields, if there is one.
 */
export function LaunchProfileConfig({
  serverId,
  providerId,
  sshHost,
  dir,
  onChange,
}: {
  /** The Switch server the agent belongs to, whose fields the form shows; null when none is chosen. */
  serverId: string | null;
  providerId: AgentProviderId | null;
  /** The host the agent will run on: its SSH alias, or null for this machine. */
  sshHost: string | null;
  dir: string;
  onChange: (config: AgentProviderConfig | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const local = useLocalAdvancedFields(serverId, providerId);
  const fields = local.surface === 'launch-profile' ? local.fields : NO_FIELDS;

  // The models that host offers, for the fields bound to it. Asked of the host
  // the agent will run on, since that is what decides the answer — and only once
  // a directory has been chosen, because before that there is no host to ask.
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, sshHost ?? 'local', dir],
    queryFn: (): Promise<ModelCatalogueResult> =>
      providerId && dir.trim()
        ? rpc.agents.modelCatalogue({ providerId, sshHost, dir })
        : Promise.resolve({ kind: 'unavailable', reason: 'No host to ask yet.' }),
    enabled: !!providerId && dir.trim().length > 0,
    staleTime: 60_000,
  });

  const [state, setState] = useState<FormState>({});
  useEffect(() => {
    setState(emptyForm(fields));
  }, [fields]);

  useEffect(() => {
    onChange(
      providerId
        ? providerConfigFromAttributes(providerId, attributesFromForm(fields, state))
        : null
    );
  }, [providerId, fields, state, onChange]);

  const setField = useCallback((key: string, value: FormValue) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Also rendered for a provider that keeps no per-agent settings, so a
  // problem with the server's fields for it is still shown.
  if (!providerId || local.surface === undefined || local.surface === 'definition') return null;

  const providerLabel = getProvider(providerId)?.name ?? providerId;

  return (
    <div className="flex flex-col gap-2">
      {fields.length > 0 && (
        <DisclosureRow
          open={open}
          title="Advanced configuration"
          meta={`${providerLabel} · ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`}
          onToggle={() => setOpen((v) => !v)}
        />
      )}
      {open && (
        <div className="flex flex-col gap-4 pt-3">
          {fields.map((field) => {
            const catalogueState = fieldCatalogueState(field, state, catalogue);
            const rendered = fieldWithCatalogue(field, catalogueState);
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={`launch-profile-${field.key}`}>
                  {field.label} (optional)
                </FieldLabel>
                <DefinitionFieldInput
                  field={rendered}
                  value={state[field.key] ?? ''}
                  disabled={catalogueState.disabled}
                  suggestions={catalogueState.suggestions}
                  onChange={(value) => setField(field.key, value)}
                />
                {field.help && (
                  <FieldDescription className="text-foreground-muted">
                    {field.help}
                  </FieldDescription>
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
        </div>
      )}
      <AdvancedConfigProblem problem={local.problem} />
    </div>
  );
}

const NO_FIELDS: RepoAgentField[] = [];

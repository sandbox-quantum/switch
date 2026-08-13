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
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
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

/**
 * Collapsed "Advanced configuration" section for a provider that keeps its
 * per-agent settings in a launch profile (Codex, OpenCode). Reports the assembled
 * per-agent provider config (or null when nothing is set) so the modal can pass
 * it to `addAgent`, which persists it on the agent and folds it into the profile.
 *
 * The fields are the same ones the agent's Settings tab edits after creation —
 * fetched over RPC from the provider's own plugin, so the two forms cannot drift,
 * and the section renders nothing for a provider that declares none. That empty
 * field list is the gate: no caller needs to know which providers have one.
 */
export function LaunchProfileConfig({
  providerId,
  sshHost,
  dir,
  onChange,
}: {
  providerId: AgentProviderId | null;
  /** The host the agent will run on: its SSH alias, or null for this machine. */
  sshHost: string | null;
  dir: string;
  onChange: (config: AgentProviderConfig | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['agentAdvancedFields', providerId],
    queryFn: () => (providerId ? rpc.agents.advancedFields({ providerId }) : Promise.resolve([])),
    enabled: !!providerId,
  });
  const fields = useMemo(() => data ?? [], [data]);

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

  if (!providerId || fields.length === 0) return null;

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
    </div>
  );
}

import type { AdvancedConfigValue } from '@switch-console/plugins/agents';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  advancedConfigFromForm,
  MODEL_FIELD,
} from '@renderer/features/managed-agents/managed-agent-changes';
import { useAdvancedConfigSchema } from '@renderer/features/managed-agents/use-managed-agents';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field } from '@renderer/lib/ui/field';
import { Switch } from '@renderer/lib/ui/switch';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { AdvancedConfigField } from '@shared/core/managed-agents/managed-agents';
import { type AgentProviderId, getProvider } from '@shared/core/providers/agent-provider-registry';
import { emptyForm, type FormState, type FormValue } from '../agent-definition-fields';
import type { ModelCatalogueResult } from '../agent-model-catalogue';
import { AdvancedConfigSection } from './agent-advanced-config';
import { newAgentMachineNotice } from './managed-run-location';

const NO_SCHEMA: AdvancedConfigField[] = [];

/** Under the run location: whether the new agent runs managed there, and turning the machine on when it cannot yet. */
export function ManagedRunLocationNotice({
  machine,
  label,
  sshHost,
  serverId,
  workspaceId,
  onEnabled,
}: {
  machine: NewAgentMachine;
  label: string;
  sshHost: string | null;
  serverId: string;
  workspaceId: string;
  onEnabled: () => void;
}) {
  const [enabling, setEnabling] = useState(false);
  const [autoTried, setAutoTried] = useState<string | null>(null);
  const notice = newAgentMachineNotice(machine, { label, sshHost });
  const canEnable = notice.kind === 'blocked' && notice.enable !== null;
  const where = `${serverId}:${workspaceId}:${sshHost ?? 'this-computer'}`;
  const enableRef = useRef(enable);
  enableRef.current = enable;

  // A machine that can be set up for managed agents is set up as soon as it is
  // chosen, as the automatic move to managed would: on a server with agent
  // management that is how agents run, so asking first only stands in the way.
  // Tried once per machine; if it fails, the button below is the way to retry.
  useEffect(() => {
    if (!canEnable || autoTried === where) return;
    setAutoTried(where);
    void enableRef.current();
  }, [canEnable, where, autoTried]);

  if (enabling)
    return (
      <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
        <Server className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {sshHost
            ? `Setting ${label} up to run managed agents…`
            : 'Setting this computer up to run managed agents…'}
        </span>
      </p>
    );

  if (notice.kind !== 'blocked')
    return (
      <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
        {notice.kind === 'managed' && <Server className="mt-0.5 size-3.5 shrink-0" />}
        <span>{notice.text}</span>
      </p>
    );

  async function enable() {
    setEnabling(true);
    try {
      if (sshHost) await rpc.hostControllers.enable({ sshHost, serverId, workspaceId });
      else await rpc.embeddedController.enable({ serverId, workspaceId });
      onEnabled();
    } catch (error) {
      const { headline, detail } = describeFailure(
        error,
        sshHost ? `Could not make ${label} a machine.` : 'Could not turn on managed agents here.'
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <span>{notice.text}</span>
        {notice.enable && (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={enabling}
            onClick={() => void enable()}
          >
            {enabling ? 'Turning on…' : notice.enable.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Where the model list for a new managed agent comes from, or why it cannot be read. */
export type ManagedCatalogueHost =
  | { kind: 'host'; sshHost: string | null; dir: string }
  | { kind: 'unavailable'; reason: string };

/** The model and advanced configuration a new managed agent is created with. */
export type ManagedDefinitionSettings = {
  model: string | null;
  advancedConfig: Record<string, AdvancedConfigValue>;
};

/**
 * The same "Advanced configuration" the form shows for an agent this Console
 * runs, with the fields the server checks a managed agent's definition against:
 * the model first, then the provider's settings. Model suggestions come from
 * the machine's own provider CLI when this Console can reach it.
 */
export function ManagedAdvancedConfig({
  serverId,
  providerId,
  host,
  onChange,
}: {
  serverId: string;
  providerId: AgentProviderId;
  host: ManagedCatalogueHost;
  onChange: (settings: ManagedDefinitionSettings) => void;
}) {
  const schemaQuery = useAdvancedConfigSchema(serverId);
  const schema = schemaQuery.data?.[providerId] ?? NO_SCHEMA;
  const fields = useMemo(() => [MODEL_FIELD, ...schema], [schema]);
  const asked = host.kind === 'host' && host.dir.trim() !== '' ? host : null;
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, asked?.sshHost ?? 'local', asked?.dir],
    queryFn: () =>
      rpc.agents.modelCatalogue({ providerId, sshHost: asked!.sshHost, dir: asked!.dir }),
    enabled: asked !== null,
    staleTime: 60000,
  });
  const hostCatalogue: ModelCatalogueResult | undefined =
    host.kind === 'unavailable'
      ? { kind: 'unavailable', reason: host.reason }
      : asked === null
        ? {
            kind: 'unavailable',
            reason:
              'No directory is chosen yet, so there is nowhere to ask the machine for its models. You can enter a model alias or ID.',
          }
        : catalogue;

  const [form, setForm] = useState<FormState>({});
  useEffect(() => {
    const initial = emptyForm(fields);
    setForm(initial);
    onChange({ model: null, advancedConfig: advancedConfigFromForm(schema, initial) });
  }, [fields, schema, onChange]);

  const setField = (key: string, value: FormValue) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      onChange({
        model: String(next[MODEL_FIELD.key] ?? '').trim() || null,
        advancedConfig: advancedConfigFromForm(schema, next),
      });
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <AdvancedConfigSection
        providerLabel={getProvider(providerId)?.name ?? providerId}
        fields={fields}
        form={form}
        catalogue={hostCatalogue}
        onFieldChange={setField}
      />
      {schemaQuery.error && (
        <p role="alert" className="text-xs text-foreground-destructive">
          {failureText(
            schemaQuery.error,
            'The server’s settings for this provider could not be read, so only the model can be set.'
          )}
        </p>
      )}
    </div>
  );
}

/** Whether the new agent may create agents on the owner's machines, set as it is created. */
export function CanManageAgentsField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field>
      <label className="-mx-2 flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--sel-soft)]">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm">
            Can manage agents
            <InfoTooltip
              label="More info about managing agents"
              content="The agent can see your machines and managed agents, and create agents that run on your machines and belong to you. Agents it creates do not get this permission."
            />
          </span>
          <span className="text-xs text-foreground-muted">
            Let this agent create agents on your machines.
          </span>
        </span>
        <Switch
          className="mt-0.5"
          aria-label="Can manage agents"
          checked={checked}
          onCheckedChange={onChange}
        />
      </label>
    </Field>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { ManagedAgentSection } from '@renderer/features/agent-migration/managed-agent-section';
import { LocalDirectorySelector } from '@renderer/features/locations/components/add-agent-modal/local-directory-selector';
import type {
  FormState,
  FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import type { ModelCatalogueResult } from '@renderer/features/locations/components/agent-model-catalogue';
import {
  AgentEditsProvider,
  useAgentEdit,
} from '@renderer/features/locations/components/main-panel/agent-edits';
import { AgentInstructionsField } from '@renderer/features/locations/components/main-panel/agent-instructions-section';
import { AgentHeaderLayout } from '@renderer/features/locations/components/main-panel/agent-page-header';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { AgentSaveBar } from '@renderer/features/locations/components/main-panel/agent-save-bar';
import { AddressingPolicyRow } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import {
  AdvancedConfigDisclosure,
  summariseValues,
} from '@renderer/features/locations/components/settings-view/sections/advanced-config-disclosure';
import { AutoApproveRow } from '@renderer/features/locations/components/settings-view/sections/auto-approve-settings-section';
import { CanManageAgentsRow } from '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section';
import { SettingRow } from '@renderer/features/locations/components/settings-view/sections/setting-row';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { workspaceAgentsQueryKey } from '@renderer/lib/stores/use-workspace-agents';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type {
  AdvancedConfigField,
  ManagedAgentView,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import {
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { InlineEditableText } from './inline-editable-text';
import {
  type Draft,
  draftOf,
  editIsEmpty,
  editOf,
  managedAdvancedFields,
  MODEL_FIELD,
} from './managed-agent-changes';
import { managedAgentLabel } from './managed-agent-state';
import { ManagedMachinePill } from './managed-machine-card';
import {
  MANAGED_AGENTS_KEY,
  useAdvancedConfigSchema,
  useManagedMachines,
} from './use-managed-agents';

const NO_FIELDS: AdvancedConfigField[] = [];

const DIRECTORY_PLACEHOLDER = 'Where the agent runs';

const SESSIONS_START_WHEN_ADDRESSED =
  'Sessions of an agent on a machine start when it is addressed in a room.';

type Edits = { values: Partial<Omit<Draft, 'form'>>; form: FormState };
const NO_EDITS: Edits = { values: {}, form: {} };

/**
 * A managed agent, on the same page a Console agent has: who it is, the machine
 * it runs on, how it behaves, and its sessions. Every edit on it is one set of
 * pending changes for the page's save bar; the server checks the definition
 * against the agent's machine and refuses it whole.
 */
export function ManagedAgentPage({ agent }: { agent: ManagedAgentView }) {
  return (
    <AgentEditsProvider>
      <ManagedAgentPageContent agent={agent} />
    </AgentEditsProvider>
  );
}

function ManagedAgentPageContent({ agent }: { agent: ManagedAgentView }) {
  const queryClient = useQueryClient();
  const showAddToRoom = useShowModal('addAgentToRoomModal');
  const schemaQuery = useAdvancedConfigSchema(agent.serverId);
  const machines = useManagedMachines(agent.serverId);
  const schema = schemaQuery.data?.[agent.definition.provider] ?? NO_FIELDS;
  const fields = useMemo(() => managedAdvancedFields(schema), [schema]);

  const machine = machines.data?.find((candidate) => candidate.id === agent.machine?.id) ?? null;
  const saved = useMemo(() => draftOf(agent, schema, machine), [agent, schema, machine]);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const draft: Draft = { ...saved, ...edits.values, form: { ...saved.form, ...edits.form } };
  const edit = editOf(agent, schema, saved, draft);
  const [error, setError] = useState<string | null>(null);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  const setValue = <K extends keyof Edits['values']>(key: K, value: Draft[K]) =>
    setEdits((current) => ({ ...current, values: { ...current.values, [key]: value } }));
  const setField = (key: string, value: FormValue) =>
    setEdits((current) => ({ ...current, form: { ...current.form, [key]: value } }));

  const save = async () => {
    setError(null);
    if (!draft.description.trim()) {
      setError(
        'Give the agent a description before saving: it is how people and agents know what it is for.'
      );
      return;
    }
    const target = { workspaceId: agent.workspaceId, agentId: agent.agentId };
    const done: string[] = [];
    try {
      if (Object.keys(edit.changes.definition).length > 0) {
        await rpc.managedAgents.update({
          serverId: agent.serverId,
          agentId: agent.agentId,
          changes: edit.changes,
        });
        done.push('its settings');
      }
      if (edit.displayName !== undefined) {
        await rpc.workspaces.updateAgentDisplayName({ ...target, displayName: edit.displayName });
        done.push('its display name');
      }
      if (edit.description !== undefined) {
        await rpc.workspaces.updateAgentDescription({ ...target, description: edit.description });
        done.push('its description');
      }
      if (edit.iconUrl !== undefined)
        await rpc.workspaces.updateAgentIcon({ ...target, iconUrl: edit.iconUrl });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: workspaceAgentsQueryKey(agent.workspaceId) });
      setEdits(NO_EDITS);
    } catch (failure) {
      if (done.length === 0) {
        setError(failureText(failure, 'The changes could not be saved. Nothing changed.'));
        return;
      }
      // What did save comes back from the server equal to the edit, so only
      // what did not is left pending.
      setError(
        `Saved ${done.join(' and ')}, but not the rest: ${failureText(failure, 'the server refused it.')}`
      );
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
    }
  };

  const revert = () => {
    setEdits(NO_EDITS);
    setError(null);
  };

  useAgentEdit({ id: 'managed-agent', order: 0, dirty: !editIsEmpty(edit), save, revert });

  const catalogue = useHostCatalogue(agent, machines);
  const title = draft.displayName.trim() || agent.name;
  const provider = providerDisplayName(agent.definition.provider);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-8 pb-20">
          <AgentHeaderLayout
            avatar={
              <AgentIconPicker
                serverId={agent.serverId}
                name={title}
                iconUrl={draft.iconUrl}
                onChange={(iconUrl) => setValue('iconUrl', iconUrl)}
                size={88}
              />
            }
            title={
              <InlineEditableText
                value={draft.displayName}
                placeholder={agent.name}
                mutedPlaceholder={false}
                label="Display name"
                className="text-3xl font-semibold tracking-tight"
                onChange={(value) => setValue('displayName', value)}
              />
            }
            badges={
              <>
                {provider && (
                  <Badge variant="secondary" className="h-5 shrink-0 px-2 text-[11px]">
                    {provider}
                  </Badge>
                )}
                <ManagedMachinePill agent={agent} machines={machines} />
              </>
            }
            machineName={title !== agent.name ? agent.name : null}
            description={
              <InlineEditableText
                value={draft.description}
                placeholder="Add a description"
                mutedPlaceholder
                label="Description"
                className="text-sm"
                onChange={(value) => setValue('description', value)}
              />
            }
            actions={
              <>
                <WithReason reason={SESSIONS_START_WHEN_ADDRESSED}>
                  <Button disabled>New Session</Button>
                </WithReason>
                <Button
                  variant="outline"
                  onClick={() =>
                    showAddToRoom({
                      workspaceId: agent.workspaceId,
                      switchAgentId: agent.agentId,
                      agentName: managedAgentLabel(agent),
                    })
                  }
                >
                  <Plus className="size-4" />
                  Add to room
                </Button>
              </>
            }
          />

          <div className="flex flex-col gap-10">
            <AgentInstructionsField
              value={draft.instructions}
              onChange={(value) => setValue('instructions', value)}
              expanded={instructionsExpanded}
              onExpandedChange={setInstructionsExpanded}
              actions={null}
            />
            <section className="flex flex-col gap-6">
              <SectionLabel>General</SectionLabel>
              <SettingRow
                title="Auto-create a session on notify"
                info={{
                  label: 'More info about auto-created sessions',
                  content:
                    'A session starts by itself when the agent is addressed, so a message never waits for someone to open one.',
                }}
                description="Start a session when this agent is addressed."
                control={
                  <WithReason reason="Agents on a machine always start a session when addressed.">
                    <Switch aria-label="Auto-create a session on notify" checked disabled />
                  </WithReason>
                }
              />
              <AutoApproveRow
                control={
                  <Switch
                    aria-label="Bypass permissions"
                    checked={draft.autoApprove}
                    onCheckedChange={(checked) => setValue('autoApprove', checked)}
                  />
                }
              />
              <CanManageAgentsRow
                workspaceId={agent.workspaceId}
                agentId={agent.agentId}
                agentName={null}
              />
              <AddressingPolicyRow
                workspaceId={agent.workspaceId}
                serverId={agent.serverId}
                agentId={agent.agentId}
                agentName={agent.name}
                showName={false}
              />
              <SettingRow
                title="Directory"
                info={{
                  label: 'More info about the directory',
                  content:
                    'The working directory, a full path on its machine. Its sessions start there.',
                }}
                description={`Where the agent runs on ${agent.machine?.name ?? 'its machine'}.`}
                control={null}
              >
                {machine?.local?.kind === 'this-computer' ? (
                  <LocalDirectorySelector
                    title="Choose the agent's working directory"
                    message="The agent runs its sessions here."
                    path={draft.directory}
                    onPathChange={(path) => setValue('directory', path)}
                    placeholder={DIRECTORY_PLACEHOLDER}
                  />
                ) : (
                  <Input
                    aria-label="Directory"
                    value={draft.directory}
                    placeholder={DIRECTORY_PLACEHOLDER}
                    onChange={(event) => setValue('directory', event.target.value)}
                  />
                )}
              </SettingRow>
              <SettingRow
                title="Run in its own process"
                info={{
                  label: 'More info about running in its own process',
                  content:
                    'Isolated from the other agents on its machine, instead of inside the machine’s controller.',
                }}
                description="Keep it apart from the other agents on its machine."
                control={
                  <Switch
                    aria-label="Run in its own process"
                    checked={draft.ownProcess}
                    onCheckedChange={(checked) => setValue('ownProcess', checked)}
                  />
                }
              />
            </section>
            <div className="flex flex-col gap-2">
              <AdvancedConfigDisclosure
                fields={fields}
                form={draft.form}
                summary={summariseValues([MODEL_FIELD, ...schema], saved.form)}
                catalogue={catalogue}
                intro="The agent's model and its provider's settings. Its instructions are above, and its name is fixed."
                onFieldChange={setField}
              />
              {schemaQuery.error && (
                <p role="alert" className="text-xs text-foreground-destructive">
                  {failureText(
                    schemaQuery.error,
                    `The server's settings for ${provider ?? agent.definition.provider} could not be read, so only the model can be changed here.`
                  )}
                </p>
              )}
            </div>
          </div>

          <section className="relative flex w-full flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Sessions</SectionLabel>
              <WithReason reason={SESSIONS_START_WHEN_ADDRESSED}>
                <Button variant="ghost" size="icon-xs" aria-label="New session" disabled>
                  <Plus className="size-4" />
                </Button>
              </WithReason>
            </div>
            <p className="py-2 text-sm text-foreground-muted">
              Sessions of agents on a machine are not listed here yet.
            </p>
          </section>

          <MovedFromConsole agent={agent} />
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="shrink-0 border-t border-border px-8 pt-3 text-sm text-foreground-destructive"
        >
          {error}
        </p>
      )}
      <AgentSaveBar />
    </div>
  );
}

/**
 * The models the agent's machine offers, asked of it the way a Console agent's
 * host is asked — when this Console can reach that machine, and the agent has a
 * directory there to ask in. Otherwise why not, which the model field shows
 * while staying free text.
 */
function useHostCatalogue(
  agent: ManagedAgentView,
  machines: { data: OwnedMachine[] | null | undefined; error: unknown }
): ModelCatalogueResult | undefined {
  const machine = machines.data?.find((candidate) => candidate.id === agent.machine?.id) ?? null;
  const providerId = isValidProviderId(agent.definition.provider)
    ? agent.definition.provider
    : null;
  const dir = agent.definition.directory ?? agent.status?.directory ?? null;
  const sshHost = machine?.local?.kind === 'ssh-host' ? machine.local.sshHost : null;
  const query = useQuery({
    queryKey: ['agent-model-catalogue', providerId, sshHost ?? 'local', dir],
    queryFn: () => rpc.agents.modelCatalogue({ providerId: providerId!, sshHost, dir: dir! }),
    enabled: providerId !== null && dir !== null && !!machine?.local,
    staleTime: 60_000,
  });
  const unavailable = (reason: string): ModelCatalogueResult => ({ kind: 'unavailable', reason });
  if (machines.error)
    return unavailable(failureText(machines.error, 'Your machines could not be listed.'));
  if (providerId === null)
    return unavailable(`Console does not know the provider “${agent.definition.provider}”.`);
  if (!agent.machine) return unavailable('The agent is placed on no machine.');
  if (machines.data === undefined) return undefined;
  if (!machine?.local)
    return unavailable(
      `${agent.machine.name} is not this computer or one of its SSH hosts, so Console cannot ask it. You can enter a model ID.`
    );
  if (dir === null)
    return unavailable(
      'The machine has not said which directory the agent runs in yet, so there is nowhere to ask. You can enter a model ID.'
    );
  if (query.error)
    return unavailable(failureText(query.error, 'The machine’s models could not be read.'));
  return query.data;
}

/** A disabled control, with why it is disabled on hover. A span carries the tooltip: a disabled button emits no pointer events. */
function WithReason({ reason, children }: { reason: string; children: React.ReactNode }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex">{children}</span>} />
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * An agent moved to managed from this Console still has its entry here, which
 * is what bringing it back needs: "Stop managing" lives with it.
 */
const MovedFromConsole = observer(function MovedFromConsole({
  agent,
}: {
  agent: ManagedAgentView;
}) {
  const { navigate } = useNavigate();
  const local = agentsStore
    .agentsOnServer(agent.serverId)
    .find((candidate) => candidate.switchAgentId === agent.agentId);
  if (!local) return null;
  return (
    <ManagedAgentSection
      agentId={local.id}
      onReturned={() =>
        navigate('location', { locationId: local.locationId, agentName: local.name })
      }
    />
  );
});

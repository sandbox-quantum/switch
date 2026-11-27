import { summariseValues } from '@switch-console/chat-ui/components/advanced-config-disclosure';
import { AgentSettingsPage } from '@switch-console/chat-ui/components/agent-settings-page';
import { Badge } from '@switch-console/chat-ui/primitives/badge';
import { Button } from '@switch-console/chat-ui/primitives/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@switch-console/chat-ui/primitives/tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AgentIdentityActions } from '@renderer/features/agent-identity/agent-identity-actions';
import { agentNamesChanged } from '@renderer/features/agent-identity/agent-names-changed';
import { LocalDirectorySelector } from '@renderer/features/locations/components/add-agent-modal/local-directory-selector';
import type {
  FormState,
  FormValue,
} from '@renderer/features/locations/components/agent-definition-fields';
import type { ModelCatalogueResult } from '@renderer/features/locations/components/agent-model-catalogue';
import {
  AgentEditsProvider,
  useAgentEdit,
  useAgentEdits,
} from '@renderer/features/locations/components/main-panel/agent-edits';
import { AgentSaveBar } from '@renderer/features/locations/components/main-panel/agent-save-bar';
import { AddressingPolicyRow } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { AdvancedConfigDisclosure } from '@renderer/features/locations/components/settings-view/sections/advanced-config-disclosure';
import { CanManageAgentsRow } from '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section';
import { MidTurnDeliveryRow } from '@renderer/features/locations/components/settings-view/sections/mid-turn-delivery-section';
import { ServiceGrantsRow } from '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { workspaceAgentsQueryKey } from '@renderer/lib/stores/use-workspace-agents';
import {
  type AdvancedConfigField,
  isCloudMachine,
  type ManagedAgentView,
  type OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import {
  autoModeIsUnreviewed,
  isValidProviderId,
  providerDisplayName,
  providerSupportsAutoMode,
} from '@shared/core/providers/agent-provider-registry';
import { catalogueAsReported } from './catalogue-as-reported';
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
import { useManagedAgentActions } from './use-managed-agent-actions';
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
 * against the agent's machine and refuses it whole. `serviceGrants` shows its
 * Service access, which a page offering Connections shows there instead.
 */
export function ManagedAgentPage({
  agent,
  serviceGrants,
}: {
  agent: ManagedAgentView;
  serviceGrants: boolean;
}) {
  return (
    <AgentEditsProvider>
      <ManagedAgentPageContent agent={agent} serviceGrants={serviceGrants} />
    </AgentEditsProvider>
  );
}

function ManagedAgentPageContent({
  agent,
  serviceGrants,
}: {
  agent: ManagedAgentView;
  serviceGrants: boolean;
}) {
  const queryClient = useQueryClient();
  const showAddToRoom = useShowModal('addAgentToRoomModal');
  const showRename = useShowModal('renameAgentModal');
  const showMove = useShowModal('moveAgentModal');
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
  const chatsOn = useFeatureFlags(agent.serverId).agent_chats;
  const { busy, remove } = useManagedAgentActions(agent);

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
        agentNamesChanged();
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
  useConfirmLeave(agent);

  const catalogue = useHostCatalogue(agent, machines);
  const title = draft.displayName.trim() || agent.name;
  const provider = providerDisplayName(agent.definition.provider);

  return (
    <AgentSettingsPage
      saveBar={<AgentSaveBar />}
      error={error}
      identity={{
        avatar: (
          <AgentIconPicker
            serverId={agent.serverId}
            name={title}
            iconUrl={draft.iconUrl}
            onChange={(iconUrl) => setValue('iconUrl', iconUrl)}
            size={88}
          />
        ),
        name: agent.name,
        displayName: draft.displayName,
        description: draft.description,
        onDisplayNameChange: (value) => setValue('displayName', value),
        onDescriptionChange: (value) => setValue('description', value),
        badges: (
          <>
            {provider && (
              <Badge variant="secondary" className="h-5 shrink-0 px-2 text-[11px]">
                {provider}
              </Badge>
            )}
            <ManagedMachinePill agent={agent} machines={machines} />
          </>
        ),
        titleActions: (
          <AgentIdentityActions
            onRename={() =>
              showRename({
                workspaceId: agent.workspaceId,
                switchAgentId: agent.agentId,
                currentName: agent.name,
                currentDisplayName: saved.displayName.trim() || null,
                // Its machine keeps its files, under its own name for it.
                localAgentId: null,
                onSuccess: ({ outcome }) => {
                  void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
                  void queryClient.invalidateQueries({
                    queryKey: workspaceAgentsQueryKey(agent.workspaceId),
                  });
                  // The display name now comes from the server, so a
                  // pending edit of it is dropped rather than re-sent.
                  setEdits((current) => {
                    const { displayName: _dropped, ...values } = current.values;
                    return { ...current, values };
                  });
                  toast({
                    title: `Renamed to ${outcome.agent.displayName ?? outcome.agent.name}`,
                    description:
                      outcome.bridgeFailures.length > 0
                        ? outcome.bridgeFailures.map((f) => `Not yet updated on ${f}.`).join(' ')
                        : undefined,
                    variant: outcome.bridgeFailures.length > 0 ? 'destructive' : undefined,
                  });
                },
              })
            }
            onDelete={remove}
            disabled={!editIsEmpty(edit)}
          />
        ),
        actions: (
          <>
            {!chatsOn && (
              <WithReason reason={SESSIONS_START_WHEN_ADDRESSED}>
                <Button disabled>New Session</Button>
              </WithReason>
            )}
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
        ),
      }}
      definition={{
        instructions: draft.instructions,
        onInstructionsChange: (value) => setValue('instructions', value),
        autoMode: providerSupportsAutoMode(agent.definition.provider) ? draft.autoMode : null,
        unreviewedAutoMode: autoModeIsUnreviewed(agent.definition.provider)
          ? providerDisplayName(agent.definition.provider)
          : null,
        onAutoModeChange: (checked) => setValue('autoMode', checked),
        autoApprove: draft.autoApprove,
        onAutoApproveChange: (checked) => setValue('autoApprove', checked),
      }}
      serverRows={
        <>
          <CanManageAgentsRow
            workspaceId={agent.workspaceId}
            agentId={agent.agentId}
            agentName={null}
          />
          <MidTurnDeliveryRow workspaceId={agent.workspaceId} agentId={agent.agentId} />
          <AddressingPolicyRow
            workspaceId={agent.workspaceId}
            serverId={agent.serverId}
            agentId={agent.agentId}
            agentName={agent.name}
            showName={false}
          />
          {serviceGrants && (
            <ServiceGrantsRow
              serverId={agent.serverId}
              workspaceId={agent.workspaceId}
              agentId={agent.agentId}
              agentName={managedAgentLabel(agent)}
              cloud={agent.machine !== null && isCloudMachine(agent.machine)}
            />
          )}
        </>
      }
      machine={{
        machineName: agent.machine?.name ?? null,
        thisComputer: machine?.local?.kind === 'this-computer',
        directory: draft.directory,
        isolation: draft.ownProcess ? 'isolated' : 'shared',
        cloud: machine?.cloud ?? false,
        onDirectoryChange: (value) => setValue('directory', value),
        onIsolationChange: (value) => setValue('ownProcess', value === 'isolated'),
        onChangeDevice: () => showMove({ agent }),
        directorySelector:
          machine?.local?.kind === 'this-computer' ? (
            <LocalDirectorySelector
              title="Choose the agent’s working directory"
              message="The agent runs its sessions here."
              path={draft.directory}
              onPathChange={(path) => setValue('directory', path)}
              placeholder={DIRECTORY_PLACEHOLDER}
            />
          ) : undefined,
      }}
      advanced={
        <>
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
        </>
      }
      onDelete={chatsOn ? remove : null}
      deleting={busy}
      machineWord="machine"
    />
  );
}

/**
 * While the page has unsaved changes, leaving it — another screen, another
 * agent, a chat beside it, or closing the window — asks first.
 */
function useConfirmLeave(agent: ManagedAgentView) {
  const { dirty, revertAll } = useAgentEdits();
  const confirm = useShowModal('confirmActionModal');
  const { section } = useParams('managedAgent').params;
  const { serverId, agentId } = agent;
  useEffect(() => {
    if (!dirty) return;
    appState.navigation.setLeaveGuard((viewId, params) => {
      const target = (params ?? {}) as { serverId?: string; agentId?: string; section?: string };
      if (
        viewId === 'managedAgent' &&
        target.serverId === serverId &&
        target.agentId === agentId &&
        target.section === section
      )
        return Promise.resolve(true);
      return new Promise((resolve) =>
        confirm({
          title: 'You have unsaved changes',
          description: "If you leave now, your changes to this agent's settings will be lost.",
          cancelLabel: 'Stay',
          confirmLabel: 'Discard and leave',
          onSuccess: () => {
            revertAll();
            resolve(true);
          },
          onClose: () => resolve(false),
        })
      );
    });
    const refuseUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', refuseUnload);
    return () => {
      appState.navigation.setLeaveGuard(null);
      window.removeEventListener('beforeunload', refuseUnload);
    };
  }, [dirty, revertAll, confirm, serverId, agentId, section]);
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
  return catalogueAsReported(
    query.data,
    agent.machine.name,
    agent.definition.provider,
    machine.providers.find((entry) => entry.provider === providerId)
  );
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

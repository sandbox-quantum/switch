import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useCallback, useId, useRef, useState } from 'react';
import { AgentAdvancedConfig } from '@renderer/features/locations/components/add-agent-modal/agent-advanced-config';
import { AddressingPolicyRow } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { ServiceGrantsRow } from '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import {
  useWorkspaceAgents,
  workspaceAgentsQueryKey,
} from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { CloudLaunch } from '@shared/core/cloud-agents/cloud-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import type { CloudLaunchConfiguration } from '@shared/core/switch-servers/cloud-launch';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

export const RESTART_NOTE =
  'Model and instructions changes apply when the agent restarts: use Restart, or Stop then Start.';

type Props = BaseModalProps<void> & { serverId: string; launch: CloudLaunch };

function sameAttributes(a: RepoAgentAttributes, b: RepoAgentAttributes): boolean {
  const canonical = (value: RepoAgentAttributes) =>
    JSON.stringify(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
  return canonical(a) === canonical(b);
}

export const EditCloudAgentModal = observer(function EditCloudAgentModal({
  serverId,
  launch,
  onSuccess,
  onClose,
}: Props) {
  const agentId = launch.agent_id;
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const agents = useWorkspaceAgents(workspaceId);
  const configuration = useQuery({
    queryKey: ['cloud-launch-configuration', serverId, launch.request_id],
    queryFn: () => rpc.switchServers.getCloudLaunchConfiguration(serverId, launch.request_id),
  });
  const agent = agents.data?.find((candidate) => candidate.id === agentId);
  const error = agents.error ?? configuration.error;
  const missing = agents.data !== undefined && !agent;

  if (
    agentId === null ||
    workspaceId === null ||
    error ||
    missing ||
    !agent ||
    !configuration.data
  ) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Edit {launch.name}</DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          {workspaceId === null ? (
            <p role="alert" className="text-sm text-destructive">
              This server has no workspace open, so the agent cannot be read.
            </p>
          ) : agentId === null || missing ? (
            <p role="alert" className="text-sm text-destructive">
              This cloud agent has not registered with the server yet.
            </p>
          ) : error ? (
            <p role="alert" className="text-sm text-destructive">
              {failureText(error, 'Could not load the agent’s configuration.')}
            </p>
          ) : (
            <p className="text-sm text-foreground-muted">Loading…</p>
          )}
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <EditCloudAgentForm
      serverId={serverId}
      workspaceId={workspaceId}
      launch={launch}
      agent={agent}
      configuration={configuration.data}
      onSuccess={onSuccess}
      onClose={onClose}
    />
  );
});

function EditCloudAgentForm({
  serverId,
  workspaceId,
  launch,
  agent,
  configuration,
  onSuccess,
  onClose,
}: Props & {
  workspaceId: string;
  agent: RemoteAgentSummary;
  configuration: CloudLaunchConfiguration;
}) {
  const queryClient = useQueryClient();
  const nameId = useId();
  const instructionsId = useId();
  const [displayName, setDisplayName] = useState(agent.displayName ?? '');
  const [iconUrl, setIconUrl] = useState(agent.iconUrl);
  const [instructions, setInstructions] = useState(configuration.instructions);
  const [initialAttributes] = useState(configuration.definition_attributes);
  const attributes = useRef<RepoAgentAttributes>(configuration.definition_attributes);
  const onAttributesChange = useCallback(
    (next: RepoAgentAttributes) => {
      attributes.current = { ...initialAttributes, ...next };
    },
    [initialAttributes]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editsModel = launch.provider === 'claude';

  const save = async () => {
    setSaving(true);
    setError(null);
    const nextName = displayName.trim() || null;
    const nextAttributes = editsModel ? attributes.current : configuration.definition_attributes;
    const configurationChanged =
      instructions.trim() !== configuration.instructions ||
      !sameAttributes(nextAttributes, configuration.definition_attributes);
    try {
      if (nextName !== agent.displayName)
        await rpc.workspaces.updateAgentDisplayName({
          workspaceId,
          agentId: agent.id,
          displayName: nextName,
        });
      if (iconUrl !== agent.iconUrl)
        await rpc.workspaces.updateAgentIcon({ workspaceId, agentId: agent.id, iconUrl });
      if (configurationChanged)
        await rpc.switchServers.updateCloudLaunchConfiguration(serverId, launch.request_id, {
          provider: launch.provider,
          name: launch.name,
          description: configuration.description,
          instructions,
          definition_attributes: nextAttributes,
        });
    } catch (failure) {
      setError(failureText(failure, 'Could not save the agent.'));
      setSaving(false);
      return;
    } finally {
      void queryClient.invalidateQueries({ queryKey: workspaceAgentsQueryKey(workspaceId) });
      void queryClient.invalidateQueries({
        queryKey: ['cloud-launch-configuration', serverId, launch.request_id],
      });
    }
    if (configurationChanged) toast({ title: 'Agent saved', description: RESTART_NOTE });
    onSuccess();
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Edit {launch.name}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <div className="flex justify-center">
            <AgentIconPicker
              serverId={serverId}
              name={launch.name}
              iconUrl={iconUrl}
              onChange={setIconUrl}
              size={66}
              disabled={saving}
            />
          </div>
          <Field>
            <FieldLabel htmlFor={nameId}>
              Display name <span className="text-foreground-muted">(optional)</span>
            </FieldLabel>
            <Input
              id={nameId}
              value={displayName}
              placeholder={launch.name}
              disabled={saving}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <FieldDescription>
              {providerDisplayName(launch.provider)}. The provider and repository cannot be changed;
              create a new agent instead.
            </FieldDescription>
          </Field>
          <AddressingPolicyRow
            workspaceId={workspaceId}
            serverId={serverId}
            agentId={agent.id}
            agentName={launch.name}
            showName={false}
          />
          <ServiceGrantsRow
            workspaceId={workspaceId}
            serverId={serverId}
            agentId={agent.id}
            agentName={launch.name}
            cloud
          />
          <Field>
            <FieldLabel htmlFor={instructionsId}>
              Agent instructions <span className="text-foreground-muted">(optional)</span>
            </FieldLabel>
            <Textarea
              id={instructionsId}
              rows={4}
              placeholder="How this agent should work"
              value={instructions}
              disabled={saving}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>
          {editsModel && (
            <AgentAdvancedConfig
              providerId={launch.provider}
              cloud
              sshHost={null}
              dir=""
              initial={initialAttributes}
              onChange={onAttributesChange}
            />
          )}
          <FieldDescription>{RESTART_NOTE}</FieldDescription>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}

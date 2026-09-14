import { FileText, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { loadAgentTemplateData } from '@renderer/features/templates/agent-template-data';
import { bundledTemplates } from '@renderer/features/templates/bundled-templates';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { AgentPickerRow, ChosenAgentTile } from '@renderer/lib/components/agent-picker';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';

type Props = BaseModalProps<void> & { roomId: string };

/** An agent that can be added: this install's agent, by its Switch identity. */
type Candidate = {
  id: string;
  name: string;
  providerId: string | null;
  iconUrl: string | null;
};

export const AddAgentsToRoomModal = observer(function AddAgentsToRoomModal({
  roomId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard, transitionModal } = useModalContext();
  const serverId = switchRoomsStore.roomServerId(roomId);
  const roomName = switchRoomsStore.roomNameById(roomId);

  // The other way an agent joins a room: made on the spot from a template.
  // Bundled ones are always on offer; the server's arrive when it answers.
  const [serverTemplates, setServerTemplates] = useState<StoredTemplateSummary[]>([]);
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    rpc.switchServers
      .listTemplates({ serverId, kind: 'agent' })
      .then((list) => {
        if (!cancelled) setServerTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setServerTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);
  const templates: StoredTemplateSummary[] = [
    ...bundledTemplates
      .filter((b) => b.kind === 'agent')
      .map(({ id, name, description, kind, creator }) => ({
        id,
        name,
        description,
        kind,
        creator,
      })),
    ...serverTemplates.filter((t) => t.kind === 'agent'),
  ];
  const [openingTemplate, setOpeningTemplate] = useState<string | null>(null);
  const createFromTemplate = async (template: StoredTemplateSummary) => {
    if (!serverId) return;
    setOpeningTemplate(template.id);
    try {
      const data = await loadAgentTemplateData(serverId, template);
      transitionModal('addAgentModal', {
        entryPoint: 'server_page',
        template: data,
        intoRoomId: roomId,
        onClose,
      });
    } catch (error) {
      toast({
        title: `Could not use "${template.name}"`,
        description: failureText(error, 'Check the server connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setOpeningTemplate(null);
    }
  };

  const [selected, setSelected] = useState<Candidate[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who can be added is answered from the same state the sidebar draws the room
  // from, not from a query of its own: the room's members and the agents on
  // offer have to be the same two sets the tree uses, or the picker and the
  // sidebar can disagree about who is already in the room.
  const members = new Set(switchRoomsStore.localMemberIds(roomId));
  // The agents' own icons live on the server, not in the local row, so the
  // list is joined against the server's summary to draw them.
  const { data: remoteAgents } = useRemoteAgents(serverId);
  const remoteById = new Map((remoteAgents ?? []).map((agent) => [agent.id, agent]));
  // Only this install's agents are offered. An agent registered on another
  // Switch Console could be added server-side but could never be shown or driven
  // from here, so it is not ours to offer.
  const candidates: Candidate[] = serverId
    ? agentsStore
        .agentsOnServer(serverId)
        .map((agent) => ({
          id: agent.switchAgentId as string,
          name: agent.name,
          providerId: agent.providerId ?? null,
          iconUrl: remoteById.get(agent.switchAgentId as string)?.iconUrl ?? null,
        }))
        .filter((a) => !members.has(a.id) && !selected.some((s) => s.id === a.id))
    : [];
  const nothingToAdd = candidates.length === 0 && selected.length === 0;

  const handleSubmit = useCallback(async () => {
    if (!serverId || selected.length === 0) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);
    try {
      await rpc.switchServers.addRoomAgents({
        serverId,
        roomId,
        agentIds: selected.map((a) => a.id),
        direction: 'agents_to_room',
      });
      await switchRoomsStore.refreshRoomState();
      onSuccess();
    } catch (cause) {
      setError(failureText(cause, 'Could not add the agents to this room.'));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [serverId, roomId, selected, onSuccess, setCloseGuard]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Add agents to {roomName ?? 'room'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-4">
          {!serverId && (
            <p className="text-xs text-destructive">
              This room&apos;s server is not known yet, so its members cannot be changed.
            </p>
          )}

          {serverId && templates.length > 0 && (
            <Field>
              <FieldLabel>New agent from a template</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <Button
                    key={t.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={openingTemplate !== null || isSubmitting}
                    onClick={() => void createFromTemplate(t)}
                  >
                    <FileText className="size-3.5" />
                    {openingTemplate === t.id ? 'Opening…' : t.name}
                  </Button>
                ))}
              </div>
              <span className="text-xs text-foreground-muted">
                Creates the agent and puts it in this room. Mention it here afterwards to start it.
              </span>
            </Field>
          )}

          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel>Agents</FieldLabel>
              {selected.length > 0 && (
                <span className="text-sm text-foreground-muted">{selected.length} selected</span>
              )}
            </div>

            {selected.length > 0 && (
              <div className="grid grid-cols-3 gap-2.5">
                {selected.map((agent) => (
                  <ChosenAgentTile
                    key={agent.id}
                    agent={agent}
                    subtitle={agentProviderLabel(agent.providerId)}
                    onRemove={() =>
                      setSelected((current) => current.filter((a) => a.id !== agent.id))
                    }
                  />
                ))}
              </div>
            )}

            <PickerCombobox
              items={candidates}
              onPick={(next) => {
                setSelected((current) => [...current, next]);
                setError(null);
              }}
              searchText={(item) => item.name}
              renderItem={(item) => (
                <AgentPickerRow agent={item} subtitle={agentProviderLabel(item.providerId)} />
              )}
              disabled={nothingToAdd}
              placeholder="Search agents to add..."
              emptyText="No agents found"
            />
            {nothingToAdd && (
              <p className="mt-1 text-xs text-foreground-muted">
                Every agent on this copy of Switch Console is already in the room. Agents registered
                elsewhere can only be added from the gateway.
              </p>
            )}
          </Field>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <ConfirmButton
          onClick={() => void handleSubmit()}
          disabled={!serverId || selected.length === 0 || isSubmitting}
        >
          {isSubmitting ? 'Adding…' : 'Add to room'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

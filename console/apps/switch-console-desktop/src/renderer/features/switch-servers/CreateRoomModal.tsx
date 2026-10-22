import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { chatFailure } from '@renderer/features/chats/stores/chat-errors';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { addableAgents, addablePeople } from '@renderer/features/switch-rooms/room-labels';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { agentProviderLabelFor } from '@renderer/lib/components/agent-picker';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import {
  agentParticipant,
  type Participant,
  personParticipant,
} from '@renderer/lib/components/participant-search';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { knownAgentTypeDisplayName } from '@shared/core/providers/agent-provider-registry';
import { MessagingAppSelector, SWITCH_CONSOLE } from './messaging-app-selector';
import { CreateRequestIds, canCreate, roomCreateRequest } from './room-create-request';
import { RoomNameInput } from './room-name-input';
import { switchServersStore } from './switch-servers-store';

type CreateRoomModalArgs = {
  /** Create on this server instead of the active one — for callers that are not
   * driven by the sidebar's server scope, such as onboarding. */
  serverId?: string;
};

type Props = BaseModalProps<{ roomId: string }> & CreateRoomModalArgs;

/**
 * A new room: its name, then who is in it — agents and people found in one
 * field — and, when the server has a messaging app that can make channels,
 * where it lives. Switch Console is the default and needs no app.
 */
export const CreateRoomModal = observer(function CreateRoomModal({
  serverId: overrideServerId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  // The sidebar shows one server at a time, so the room belongs to that server;
  // asking again would let the user create a room somewhere they are not
  // looking, and then wonder where it went.
  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const workspaceId = workspacesStore.idOnServerInScope(serverId || null);
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const myUserId = switchServersStore.statusFor(serverId)?.user?.id ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [where, setWhere] = useState(SWITCH_CONSOLE);
  const [picked, setPicked] = useState<Participant[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestIds] = useState(() => new CreateRequestIds(() => crypto.randomUUID()));

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', workspaceId],
    queryFn: () => rpc.workspaces.listAgents(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const tenantId = workspace?.tenantId ?? null;
  const rosterQuery = useQuery({
    queryKey: ['workspace-members', serverId, tenantId],
    queryFn: () => rpc.chats.workspaceMembers({ serverId, tenantId: tenantId as string }),
    enabled: tenantId !== null,
  });
  const allowedQuery = useQuery({
    queryKey: ['chat-agent-candidates', serverId, workspaceId, null],
    queryFn: () => rpc.chats.agentCandidates({ serverId, roomId: null }),
    enabled: serverId !== '',
  });
  const managedQuery = useManagedAgents(serverId || null);

  // Only a running bridge allowed to create channels can back a new room.
  const bridges = (bridgesQuery.data ?? []).filter(
    (b) => b.status === 'active' && b.canCreateChannels
  );
  const selectedBridge = bridges.find((b) => b.id === where) ?? null;

  const managedProviders = new Map(
    (managedQuery.data ?? []).map((managed) => [managed.agentId, managed.definition.provider])
  );
  const providerLabel = (agentId: string, knownType: string | null) =>
    managedProviders.has(agentId)
      ? agentProviderLabel(managedProviders.get(agentId))
      : (knownAgentTypeDisplayName(knownType) ?? agentProviderLabelFor(agentId, workspaceId));
  // A bridged room is driven from this install, so it takes only the agents
  // this install registered or manages, and no people at creation. A Switch
  // Console room is driven through the server: the agents the server says the
  // person may use, and its people.
  const agentCandidates = selectedBridge
    ? (agentsQuery.data ?? []).filter(
        (remote) =>
          workspaceId !== null &&
          (managedProviders.has(remote.id) ||
            agentsStore
              .agentsInWorkspace(workspaceId)
              .some((local) => local.switchAgentId === remote.id))
      )
    : addableAgents(agentsQuery.data ?? [], allowedQuery.data ?? []);
  const candidates: Participant[] = [
    ...agentCandidates.map((agent) =>
      agentParticipant(agent, providerLabel(agent.id, agent.knownAgentType))
    ),
    ...addablePeople(selectedBridge ? [] : (rosterQuery.data ?? []), new Set([myUserId ?? ''])).map(
      personParticipant
    ),
  ];
  const agentIds = picked.filter((each) => each.kind === 'agent').map((each) => each.id);
  const memberUserIds = picked.filter((each) => each.kind === 'person').map((each) => each.id);

  const trimmedName = name.trim();
  const canSubmit =
    workspaceId !== null &&
    canCreate({ bridgeId: selectedBridge?.id ?? null, name, description }) &&
    !isSubmitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      const bridgeId = selectedBridge?.id ?? null;
      const request = roomCreateRequest({
        serverId,
        workspaceId: workspaceId as string,
        bridgeId,
        name,
        description,
        instructions,
        agentIds,
        memberUserIds,
        requestId: requestIds.for({ bridgeId, name, agentIds, memberUserIds }),
      });
      if (request.kind === 'chat') {
        const chat = await rpc.chats.create(request.params);
        requestIds.succeeded();
        chatsStore.add(serverId, chat);
        sidebarStore.setGrouping('room');
        openRoomView(chat.roomId);
        onSuccess({ roomId: chat.roomId });
        return;
      }
      const result = await rpc.workspaces.createRoom(request.params);

      if (result.kind !== 'created') {
        setError(messageFor(result));
        return;
      }

      // Re-read the room state so the sidebar shows the room straight away
      // rather than at the next window focus. This goes through the sidebar's
      // own refresh rather than `refreshRoomState`, which only re-reads
      // membership for the agents the sidebar knew about when it last loaded —
      // an agent onboarded moments ago is not among them, so the room would
      // appear with nothing under it until the next reconcile.
      await refreshSidebarRoomState(true);

      // Open what was just created: listed in the sidebar, expanded in the
      // tree, and shown in the main panel. Creating a room and being left where
      // you were reads as if nothing happened — and the agent grouping does not
      // list rooms at all, so the new room would be nowhere on screen.
      sidebarStore.setGrouping('room');
      sidebarStore.ensureRoomExpanded(result.room.id);
      openRoomView(result.room.id);

      onSuccess({ roomId: result.room.id });
    } catch (cause) {
      setError(
        selectedBridge
          ? failureText(cause, 'Could not create the room.')
          : chatFailure(cause).message
      );
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New room</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          {!server && (
            <p className="text-xs text-destructive">
              No Switch server is selected, so there is nowhere to create a room. Choose a server in
              the sidebar first.
            </p>
          )}

          <Field>
            <FieldLabel htmlFor="new-room-name">Name</FieldLabel>
            <RoomNameInput
              id="new-room-name"
              value={name}
              onChange={(next) => {
                setName(next);
                setError(null);
              }}
              onSubmit={() => {
                if (canSubmit) void handleSubmit();
              }}
            />
            {/* What the name becomes, where it becomes it: a bridged room is a
                channel of the same name in its app. */}
            {trimmedName !== '' && selectedBridge && (
              <span className="text-xs text-foreground-muted">
                Created as #{trimmedName} in {selectedBridge.displayName}.
              </span>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="new-room-participants">Participants</FieldLabel>
            <ParticipantPicker
              inputId="new-room-participants"
              autoFocus={false}
              busy={isSubmitting}
              overlay={false}
              candidates={candidates}
              picked={picked}
              onChange={setPicked}
              serverId={serverId || null}
              loading={
                agentsQuery.isLoading ||
                rosterQuery.isLoading ||
                (!selectedBridge && allowedQuery.isLoading)
              }
            />
            <span className="text-xs text-foreground-muted">
              Agents answer only when someone @-mentions them.
            </span>
            {(agentsQuery.isError || (!selectedBridge && allowedQuery.isError)) && (
              <p className="text-xs text-destructive">
                {failureText(agentsQuery.error ?? allowedQuery.error, 'Could not load the agents.')}
              </p>
            )}
            {rosterQuery.isError && (
              <p className="text-xs text-destructive">
                {failureText(rosterQuery.error, 'Could not load the people.')}
              </p>
            )}
          </Field>

          {/* A bridged room's own settings; a Switch Console room has none to start with. */}
          {selectedBridge && (
            <section className="flex flex-col gap-3">
              <Input
                placeholder="What this room is for"
                aria-label="Description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
              />
              <Textarea
                placeholder="Optional guidance shown to agents when they enter the room"
                aria-label="Instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
              />
            </section>
          )}

          {bridgesQuery.isError && (
            <p className="text-xs text-destructive">
              {failureText(bridgesQuery.error, 'Could not load messaging apps.')}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContentArea>
      <DialogFooter className="sm:justify-between">
        <MessagingAppSelector
          bridges={bridges}
          value={where}
          onChange={(next) => {
            setWhere(next);
            setError(null);
            // A bridged room starts with agents only.
            if (next !== SWITCH_CONSOLE)
              setPicked((current) => current.filter((each) => each.kind === 'agent'));
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? 'Creating…' : 'Create room'}
          </ConfirmButton>
        </div>
      </DialogFooter>
    </>
  );
});

/** Turn a failed create into something the user can act on. */
function messageFor(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'bridge-unavailable':
      return result.message ?? 'The messaging app is not available.';
    default:
      return result.message ?? 'Could not create the room.';
  }
}

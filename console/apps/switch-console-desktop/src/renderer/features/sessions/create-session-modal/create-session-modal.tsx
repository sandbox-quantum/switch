import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { Agent } from '@shared/core/agents/agents';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';
import { buildConnectPrompt } from './build-connect-prompt';

// In Switch Console a "session" is a *session*: a `claude` process spawned in the agent's
// own directory. The directory is fixed (the agent), the provider is fixed (claude),
// and there is no git worktree — sessions run in the agent's location root. So the
// spawn dialog only asks for an optional name, an optional initial prompt, and an
// optional Switch room (and role in it) to connect to on start.

const NO_ROLE = '__none__';

function useDefaultLocationId(propLocationId?: string): string | undefined {
  return useMemo(() => {
    if (propLocationId) return propLocationId;
    const nav = appState.navigation;
    const navLocationId =
      nav.currentViewId === 'session'
        ? (nav.viewParamsStore['session'] as { locationId?: string } | undefined)?.locationId
        : nav.currentViewId === 'location'
          ? (nav.viewParamsStore['location'] as { locationId?: string } | undefined)?.locationId
          : undefined;
    return (
      navLocationId ??
      Array.from(getLocationManagerStore().locations.values())
        .reverse()
        .find((p) => p.state === 'mounted')?.data?.id
    );
    // oxlint-disable-next-line react/exhaustive-deps
  }, []); // computed once on mount
}

/**
 * The local agents that could actually take a session in `roomId`: registered on
 * that room's server, and already a member of the room.
 *
 * Connecting is not a join — it is an instruction in the session's opening
 * prompt — so an agent outside the room would start a session that then fails to
 * connect. Offering only members keeps that failure off the table, and the empty
 * case is surfaced rather than presented as a working choice.
 */
function useRoomMemberAgents(roomId: string | undefined): {
  agents: Agent[];
  serverId: string | null;
  loading: boolean;
} {
  const serverId = roomId ? switchRoomsStore.roomServerId(roomId) : null;

  useEffect(() => {
    if (roomId) void agentsStore.load();
  }, [roomId]);

  const membersQuery = useQuery({
    queryKey: ['roomAgentIds', serverId, roomId],
    queryFn: () => rpc.switchServers.listRoomAgentIds({ serverId: serverId!, roomId: roomId! }),
    enabled: !!serverId && !!roomId,
  });

  const memberIds = useMemo(() => new Set(membersQuery.data ?? []), [membersQuery.data]);
  const agents = [...agentsStore.byLocation.values()]
    .flat()
    .filter((a) => a.serverId === serverId && a.switchAgentId && memberIds.has(a.switchAgentId))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { agents, serverId, loading: membersQuery.isLoading || !agentsStore.loaded };
}

export const CreateSessionModal = observer(function CreateSessionModal({
  locationId,
  agentName,
  roomId,
  onClose,
}: BaseModalProps & {
  locationId?: string;
  /** When set, start the session as this Claude Code subagent of the agent. */
  agentName?: string;
  /** When set, the session connects to THIS room and the modal asks which agent
   * should join it — the inverse of the agent-first flow, for starting a session
   * from a room in the sidebar. */
  roomId?: string;
  // Accepted for source compatibility with Switch Console callers; ignored in Switch Console v0.
  strategy?: string;
  initialPR?: unknown;
}) {
  const defaultLocationId = useDefaultLocationId(locationId);
  const { navigate } = useNavigate();

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [room, setRoom] = useState<RemoteAgentRoom | null>(null);
  const [roleName, setRoleName] = useState<string>(NO_ROLE);
  const [pickedAgent, setPickedAgent] = useState<Agent | null>(null);

  // Room-first mode: the room is fixed and the agent is the open question —
  // unless the caller already answered it (a "+" on an agent row listed under
  // the room), in which case the picker just shows that agent, still switchable.
  const roomFirst = !!roomId;
  const roomMembers = useRoomMemberAgents(roomId);
  const presetAgent =
    roomMembers.agents.find(
      (a) => a.name === agentName && (!locationId || a.locationId === locationId)
    ) ?? null;
  // Auto-pick when there is only one candidate — the choice would be a
  // formality, and the user still sees which agent it resolved to.
  const effectiveAgent =
    pickedAgent ?? presetAgent ?? (roomMembers.agents.length === 1 ? roomMembers.agents[0] : null);
  const selectedLocationId = roomFirst ? effectiveAgent?.locationId : defaultLocationId;
  // Every Switch Console agent is its own Switch identity, so a session is always
  // owned by a named agent row (CHOO-1440) — the picked agent's name plays the
  // same part here as the `agentName` an agent row passes in.
  const effectiveAgentName = roomFirst ? effectiveAgent?.name : agentName;

  // A session belongs to an agent; resolve the location's agent up front so we
  // can offer the rooms it belongs to.
  const agentsQuery = useQuery({
    queryKey: ['location-agents', selectedLocationId],
    queryFn: () => rpc.agents.getAgents(selectedLocationId),
    enabled: !!selectedLocationId,
  });
  const locationAgents = agentsQuery.data ?? [];
  const agent = locationAgents[0] ?? null;

  // When a specific agent is named, the session joins rooms under that agent's
  // own Switch identity — its own agent row — so the room picker uses that
  // agent's id/server, matched by name (CHOO-1440).
  const subagent = effectiveAgentName
    ? (locationAgents.find((a) => a.name === effectiveAgentName) ?? null)
    : null;

  const serverId = effectiveAgentName ? (subagent?.serverId ?? null) : (agent?.serverId ?? null);
  const switchAgentId = effectiveAgentName
    ? (subagent?.switchAgentId ?? null)
    : (agent?.switchAgentId ?? null);

  useEffect(() => {
    if (!roomFirst && serverId && switchAgentId) {
      void switchRoomsStore.fetchAgentRooms(serverId, switchAgentId);
    }
  }, [roomFirst, serverId, switchAgentId]);

  const rooms =
    serverId && switchAgentId
      ? (switchRoomsStore.roomsFor(serverId, switchAgentId) ?? []).filter((r) => !r.archived)
      : [];
  const roomsLoading =
    !!serverId && !!switchAgentId && switchRoomsStore.isLoading(serverId, switchAgentId);
  const canConnectRoom = !roomFirst && !!serverId && !!switchAgentId;

  // In room-first mode the room is given, not chosen; everything downstream
  // (roles, the connect prompt) keys off the same value either way.
  const activeRoom: RemoteAgentRoom | null = roomFirst
    ? roomId
      ? {
          roomId,
          roomName: switchRoomsStore.roomNameById(roomId) ?? 'this room',
          archived: false,
          status: 'no_session',
          roomRole: null,
        }
      : null
    : room;
  const roleServerId = roomFirst ? roomMembers.serverId : serverId;

  // Roles are room-scoped, so only fetch once a room is chosen. The set is small
  // and changes rarely, so a plain per-room query (no shared cache) is enough.
  const rolesQuery = useQuery({
    queryKey: ['roomRoles', roleServerId, activeRoom?.roomId],
    queryFn: () =>
      rpc.switchServers.listRoomRoles({ serverId: roleServerId!, roomId: activeRoom!.roomId }),
    enabled: !!roleServerId && !!activeRoom,
  });
  const roles = rolesQuery.data ?? [];

  const canCreate = !!selectedLocationId;

  const handleSpawn = () => {
    if (!selectedLocationId) return;
    const sessionManager = getSessionManagerStore(selectedLocationId);
    if (!sessionManager) return;

    const id = crypto.randomUUID();
    const trimmedName = name.trim();
    const chosenRole = roleName !== NO_ROLE ? roleName : null;
    const initialPrompt = buildConnectPrompt(activeRoom?.roomName ?? null, chosenRole, prompt);

    void (async () => {
      const freshAgents = await rpc.agents.getAgents(selectedLocationId);
      // A named session must be OWNED by that agent's own row — identity flows
      // from `session.agent_id → agents.name`, so the session is
      // invisible/misidentified if it points at a different agent. Resolve the
      // row by name here; error out rather than silently fall back (CHOO-1440).
      const resolvedAgent = effectiveAgentName
        ? (subagent ?? freshAgents.find((a) => a.name === effectiveAgentName) ?? null)
        : (agent ?? freshAgents[0]);
      if (!resolvedAgent) {
        log.error('spawn session failed: no agent for location/subagent', {
          locationId: selectedLocationId,
          agentName: effectiveAgentName,
        });
        return;
      }
      // Declare the room before the session exists, so its connection opens
      // already claiming it and the session shows under the right room from the
      // start rather than after the agent's first connect_to_room.
      if (activeRoom) {
        await rpc.switchRooms.noteIntendedRoom({
          sessionId: id,
          roomId: activeRoom.roomId,
          roomName: activeRoom.roomName,
        });
      }
      // createSession registers the session synchronously (before its first
      // await), so it is in the manager by the time this call returns — the
      // session-view guard then finds it and navigation lands on the session.
      const created = sessionManager.createSession({
        id,
        agentId: resolvedAgent.id,
        title: trimmedName || 'Session',
        autoApprove: resolvedAgent.autoApprove,
        initialPrompt,
        agentName: effectiveAgentName || undefined,
      });
      navigate('session', { locationId: selectedLocationId, sessionId: id });
      onClose();
      await created;
    })().catch((e) => log.error('spawn session failed', e));
  };

  return (
    <>
      <DialogHeader className="flex items-center gap-2">
        <DialogTitle>
          {roomFirst
            ? `New Session · ${activeRoom?.roomName ?? 'room'}`
            : agentName
              ? `New Session · @${agentName}`
              : 'New Session'}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea>
        <div className="flex w-full flex-col gap-5">
          {roomFirst && (
            <Field>
              <FieldLabel>Agent</FieldLabel>
              <Combobox
                items={roomMembers.agents}
                value={effectiveAgent}
                onValueChange={(next: Agent | null) => setPickedAgent(next)}
                isItemEqualToValue={(a: Agent, b: Agent) => a.id === b.id}
                filter={(item: Agent, query) =>
                  item.name.toLowerCase().includes(query.toLowerCase())
                }
                autoHighlight
              >
                <ComboboxTrigger
                  disabled={roomMembers.loading || roomMembers.agents.length === 0}
                  className={cn(
                    'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
                    (roomMembers.loading || roomMembers.agents.length === 0) &&
                      'cursor-not-allowed opacity-60'
                  )}
                >
                  <span
                    className={cn(
                      'flex-1 truncate text-left',
                      !effectiveAgent && 'text-foreground-muted'
                    )}
                  >
                    {effectiveAgent
                      ? effectiveAgent.name
                      : roomMembers.loading
                        ? 'Loading agents…'
                        : 'Choose an agent'}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
                </ComboboxTrigger>
                <ComboboxContent className="min-w-(--anchor-width)">
                  <ComboboxInput showTrigger={false} placeholder="Search agents…" />
                  <ComboboxList>
                    {(item: Agent) => (
                      <ComboboxItem key={item.id} value={item}>
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>No agents found</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
              {!roomMembers.loading && roomMembers.agents.length === 0 && (
                <p className="mt-1 text-xs text-foreground-muted">
                  None of your agents is a member of this room yet. Add one from the room's page in
                  the gateway, then try again.
                </p>
              )}
            </Field>
          )}
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              autoFocus
              placeholder="Optional session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) handleSpawn();
              }}
            />
          </Field>
          {canConnectRoom && (
            <Field>
              <FieldLabel>Connect to room</FieldLabel>
              <Combobox
                items={rooms}
                value={room}
                onValueChange={(next: RemoteAgentRoom | null) => {
                  setRoom(next);
                  setRoleName(NO_ROLE);
                }}
                isItemEqualToValue={(a: RemoteAgentRoom, b: RemoteAgentRoom) =>
                  a.roomId === b.roomId
                }
                filter={(item: RemoteAgentRoom, query) =>
                  item.roomName.toLowerCase().includes(query.toLowerCase())
                }
                autoHighlight
              >
                <ComboboxTrigger
                  disabled={roomsLoading}
                  className={cn(
                    'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
                    roomsLoading && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <span
                    className={cn('flex-1 truncate text-left', !room && 'text-foreground-muted')}
                  >
                    {room ? room.roomName : roomsLoading ? 'Loading rooms…' : 'No room'}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
                </ComboboxTrigger>
                <ComboboxContent className="min-w-(--anchor-width)">
                  <ComboboxInput showTrigger={false} placeholder="Search rooms…" />
                  <ComboboxList>
                    {(item: RemoteAgentRoom) => (
                      <ComboboxItem key={item.roomId} value={item}>
                        <span className="min-w-0 flex-1 truncate">{item.roomName}</span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>No rooms found</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
              {!roomsLoading && rooms.length === 0 && (
                <p className="mt-1 text-xs text-foreground-muted">
                  This agent isn't a member of any rooms yet.
                </p>
              )}
            </Field>
          )}
          {activeRoom && (
            <Field>
              <FieldLabel>Assume role</FieldLabel>
              <Select
                value={roleName}
                onValueChange={(next) => setRoleName(next ?? NO_ROLE)}
                disabled={rolesQuery.isLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={rolesQuery.isLoading ? 'Loading roles…' : 'No role'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROLE}>No role</SelectItem>
                  {roles.map((role) => {
                    // An exclusive role already held by another agent can't be assumed.
                    const taken = role.exclusive && role.heldBy.length > 0;
                    return (
                      <SelectItem key={role.name} value={role.name} disabled={taken}>
                        {role.name}
                        {taken && ` (held by ${role.heldBy.join(', ')})`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {!rolesQuery.isLoading && roles.length === 0 && (
                <p className="mt-1 text-xs text-foreground-muted">
                  This room has no roles defined.
                </p>
              )}
            </Field>
          )}
          <Field>
            <FieldLabel>Initial prompt</FieldLabel>
            <Textarea
              placeholder="Optional prompt to send when the session starts"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </Field>
        </div>
      </DialogContentArea>
      <DialogFooter>
        <ConfirmButton size="sm" onClick={handleSpawn} disabled={!canCreate}>
          Spawn
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

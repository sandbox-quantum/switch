import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useAgentAutoApproveDefaults } from '@renderer/features/sessions/hooks/useAgentAutoApproveDefaults';
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
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';
import { buildConnectPrompt } from './build-connect-prompt';

// In switchdash a "session" is a *session*: a `claude` process spawned in the agent's
// own directory. The directory is fixed (the agent), the provider is fixed (claude),
// and there is no git worktree — sessions run in the agent's location root. So the
// spawn dialog only asks for an optional name, an optional initial prompt, and an
// optional Switch room (and role in it) to connect to on start.
const SESSION_PROVIDER = 'claude' as const;

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

export const CreateSessionModal = observer(function CreateSessionModal({
  locationId,
  subagentName,
  onClose,
}: BaseModalProps & {
  locationId?: string;
  /** When set, start the session as this Claude Code subagent of the agent. */
  subagentName?: string;
  // Accepted for source compatibility with switchdash callers; ignored in switchdash v0.
  strategy?: string;
  initialPR?: unknown;
}) {
  const selectedLocationId = useDefaultLocationId(locationId);
  const autoApproveDefaults = useAgentAutoApproveDefaults();
  const { navigate } = useNavigate();

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [room, setRoom] = useState<RemoteAgentRoom | null>(null);
  const [roleName, setRoleName] = useState<string>(NO_ROLE);

  // A session belongs to an agent; resolve the location's agent up front so we
  // can offer the rooms it belongs to.
  const agentQuery = useQuery({
    queryKey: ['locationAgent', selectedLocationId],
    queryFn: async () => {
      const agents = await rpc.agents.getAgents(selectedLocationId);
      return agents[0] ?? null;
    },
    enabled: !!selectedLocationId,
  });
  const agent = agentQuery.data ?? null;

  // When launching as a subagent, the session joins rooms under the subagent's
  // own Switch identity, so the room picker must use the subagent's id/server —
  // not the parent agent's.
  const subagentsQuery = useQuery({
    queryKey: ['subagents', agent?.id],
    queryFn: () => rpc.subagents.list(agent!.id),
    enabled: !!agent && !!subagentName,
  });
  const subagent =
    subagentName && subagentsQuery.data
      ? (subagentsQuery.data.subagents.find((s) => s.name === subagentName) ?? null)
      : null;

  const serverId = subagentName ? (subagent?.serverId ?? null) : (agent?.serverId ?? null);
  const switchAgentId = subagentName
    ? (subagent?.switchAgentId ?? null)
    : (agent?.switchAgentId ?? null);

  useEffect(() => {
    if (serverId && switchAgentId) {
      void switchRoomsStore.fetchAgentRooms(serverId, switchAgentId);
    }
  }, [serverId, switchAgentId]);

  const rooms =
    serverId && switchAgentId
      ? (switchRoomsStore.roomsFor(serverId, switchAgentId) ?? []).filter((r) => !r.archived)
      : [];
  const roomsLoading =
    !!serverId && !!switchAgentId && switchRoomsStore.isLoading(serverId, switchAgentId);
  const canConnectRoom = !!serverId && !!switchAgentId;

  // Roles are room-scoped, so only fetch once a room is chosen. The set is small
  // and changes rarely, so a plain per-room query (no shared cache) is enough.
  const rolesQuery = useQuery({
    queryKey: ['roomRoles', serverId, room?.roomId],
    queryFn: () => rpc.switchServers.listRoomRoles({ serverId: serverId!, roomId: room!.roomId }),
    enabled: !!serverId && !!room,
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
    const initialPrompt = buildConnectPrompt(room?.roomName ?? null, chosenRole, prompt);

    void (async () => {
      const resolvedAgent = agent ?? (await rpc.agents.getAgents(selectedLocationId))[0];
      if (!resolvedAgent) {
        log.error('spawn session failed: location has no agents', selectedLocationId);
        return;
      }
      // createSession registers the session synchronously (before its first
      // await), so it is in the manager by the time this call returns — the
      // session-view guard then finds it and navigation lands on the session.
      const created = sessionManager.createSession({
        id,
        agentId: resolvedAgent.id,
        title: trimmedName || 'Session',
        autoApprove: autoApproveDefaults.getDefault(SESSION_PROVIDER),
        initialPrompt,
        subagentName: subagentName || undefined,
      });
      navigate('session', { locationId: selectedLocationId, sessionId: id });
      onClose();
      await created;
    })().catch((e) => log.error('spawn session failed', e));
  };

  return (
    <>
      <DialogHeader className="flex items-center gap-2">
        <DialogTitle>{subagentName ? `New Session · @${subagentName}` : 'New Session'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea>
        <div className="flex w-full flex-col gap-5">
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
          {room && (
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

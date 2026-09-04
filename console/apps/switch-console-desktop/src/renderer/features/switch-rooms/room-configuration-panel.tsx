import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import type {
  RemoteAgentSummary,
  RemoteRoomDetail,
} from '@shared/core/switch-servers/switch-servers';
import { membershipSummary, roomTitle } from './room-labels';
import { openRoomChannel } from './room-links';

/** Query key for one room's own settings — shared so a save can write the
 * server's answer straight back into what the page is reading. */
function roomDetailKey(serverId: string, roomId: string) {
  return ['remote-room-detail', serverId, roomId] as const;
}

/**
 * A room's settings: what it is for, what it tells agents on arrival, and who is
 * in it.
 *
 * Read one room at a time rather than from the room list, which carries neither
 * the instructions nor the membership — and written straight back from the
 * server's reply, so the page always shows what was actually stored.
 */
export const RoomConfigurationPanel = observer(function RoomConfigurationPanel({
  roomId,
}: {
  roomId: string;
}) {
  const serverId = switchRoomsStore.roomServerId(roomId);
  const query = useQuery({
    queryKey: roomDetailKey(serverId ?? '', roomId),
    queryFn: () => rpc.switchServers.getRoomDetail({ serverId: serverId as string, roomId }),
    enabled: serverId !== null,
  });

  if (serverId === null) {
    return <PanelNotice title="This room’s server is still loading." />;
  }

  if (query.isPending) {
    return (
      <PanelNotice
        icon={<Loader2 className="size-5 animate-spin" />}
        title="Loading this room’s settings…"
      />
    );
  }

  if (query.isError) {
    const settingsReadFailure = describeFailure(
      query.error,
      'Could not read this room’s settings.'
    );
    return (
      <PanelNotice
        title={settingsReadFailure.headline}
        detail={settingsReadFailure.detail ?? undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3" />
            Retry
          </Button>
        }
      />
    );
  }

  const room = query.data;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-10 py-8">
        <RoomHeading room={room} />
        {/* Keyed on the room so the drafts below belong to the room on screen:
            switching rooms starts a fresh form rather than carrying half-typed
            text across. */}
        <GeneralSection key={room.id} serverId={serverId} room={room} />
        <ParticipantsSection serverId={serverId} room={room} />
        <DeleteRoomSection serverId={serverId} room={room} />
      </div>
    </div>
  );
});

/**
 * Deleting the room, last on its page and below a rule.
 *
 * Absent entirely for anyone who may not delete it, rather than shown disabled:
 * a greyed control invites you to go and find the permission, and here there is
 * none to find — the room is someone else's.
 */
const DeleteRoomSection = observer(function DeleteRoomSection({
  serverId,
  room,
}: {
  serverId: string;
  room: RemoteRoomDetail;
}) {
  const showDeleteRoomModal = useShowModal('deleteRoomModal');
  const { navigate } = useNavigate();

  if (!switchRoomsStore.canDeleteRoom(serverId, room)) return null;

  return (
    <section className="border-t border-border pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-foreground">Delete room</h3>
          <p className="text-xs text-foreground-muted">
            Removes the room and its conversation for everyone in it
            {room.bridgeType ? `, and its ${bridgePlatformLabel(room.bridgeType)} channel` : ''}.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={() =>
            showDeleteRoomModal({
              serverId,
              roomId: room.id,
              roomName: roomTitle(room),
              // The page this is on is the deleted room's own, so staying would
              // leave a settings form for something that no longer exists.
              onSuccess: () => navigate('home'),
            })
          }
        >
          Delete room…
        </Button>
      </div>
    </section>
  );
});

function RoomHeading({ room }: { room: RemoteRoomDetail }) {
  const platform = bridgePlatformLabel(room.bridgeType);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="truncate text-2xl font-semibold text-foreground">{roomTitle(room)}</h1>
        <p className="text-sm text-foreground-muted">
          {room.bridgeDisplayName
            ? `Room bridged to ${room.bridgeDisplayName}`
            : 'Room with no messaging app'}
        </p>
      </div>
      {room.externalChannelUrl && (
        <div className="flex shrink-0 items-center gap-2">
          {room.bridgeDisplayName && (
            <span className="rounded-md bg-[var(--fill)] px-2.5 py-1.5 text-xs text-foreground-muted">
              {room.bridgeDisplayName}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => openRoomChannel(room.id)}>
            <ExternalLink className="size-3.5" />
            Open in {platform}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the section is doing, once the user has stopped typing in it. */
type SaveState = { phase: 'idle' | 'saving' | 'saved' } | { phase: 'failed'; message: string };

/**
 * Description and instructions, written when Save is pressed.
 *
 * They used to commit when a field lost focus, which meant the moment they were
 * stored was the moment you looked away — and leaving the tab was the only
 * thing that reliably did it. Editing and storing are now separate acts, and
 * the button says which state the section is in: changed and unsaved, writing,
 * written, or refused in the server's own words.
 *
 * One request carries both fields, so the pair is stored together or not at all.
 */
function GeneralSection({ serverId, room }: { serverId: string; room: RemoteRoomDetail }) {
  const queryClient = useQueryClient();
  const savedDescription = room.description;
  const savedInstructions = room.instructions ?? '';
  const [description, setDescription] = useState(savedDescription);
  const [instructions, setInstructions] = useState(savedInstructions);
  const [state, setState] = useState<SaveState>({ phase: 'idle' });

  const dirty = description !== savedDescription || instructions !== savedInstructions;

  async function save() {
    setState({ phase: 'saving' });
    try {
      const updated = await rpc.switchServers.updateRoom({
        serverId,
        roomId: room.id,
        description,
        instructions,
      });
      queryClient.setQueryData(roomDetailKey(serverId, room.id), updated);
      setState({ phase: 'saved' });
    } catch (cause) {
      setState({ phase: 'failed', message: failureText(cause, 'Could not save the change.') });
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">General</h2>

      <Field
        label="Description"
        hint="Helps other people and agents understand what this room is for."
      >
        <Input
          className="h-9"
          placeholder="What this room is for"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>

      <Field label="Instructions" hint="Sent to every agent as it joins the room.">
        <Textarea
          rows={4}
          placeholder="Optional guidance shown to agents when they enter the room"
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>

      {/* The status sits beside the button rather than under a field: one
          request covers both, so there is one answer to report. */}
      <div className="flex items-center justify-end gap-3">
        <SaveStatus state={state} dirty={dirty} />
        <Button
          type="button"
          size="sm"
          disabled={!dirty || state.phase === 'saving'}
          onClick={() => void save()}
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

/** Says where the edits stand, so an unsaved change is never silent. */
function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  if (state.phase === 'failed') {
    return <span className="text-xs text-destructive">Not saved — {state.message}</span>;
  }
  if (state.phase === 'saved' && !dirty) {
    return <span className="text-xs text-foreground-muted">Saved.</span>;
  }
  if (dirty) {
    return <span className="text-xs text-foreground-muted">Unsaved changes.</span>;
  }
  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-foreground-muted">{label}</span>
      {children}
      <span className="text-xs text-foreground-muted">{hint}</span>
    </div>
  );
}

/**
 * Who is in the room, and the one way to change it from here.
 *
 * Agents and people are drawn as the same kind of card because they are the same
 * kind of fact — membership — and separating them into two lists implied a
 * hierarchy the room does not have.
 */
const ParticipantsSection = observer(function ParticipantsSection({
  serverId,
  room,
}: {
  serverId: string;
  room: RemoteRoomDetail;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  // Names for agents belonging to other installs, which this computer has no
  // local record of. Shares its key with the rest of the app, so it is usually
  // already in hand.
  const remoteAgents = useRemoteAgents(serverId);
  const remoteById = new Map((remoteAgents.data ?? []).map((a) => [a.id, a]));

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: roomDetailKey(serverId, room.id) });
    await switchRoomsStore.refreshRoomState();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Participants</h2>
          <span className="text-xs text-foreground-muted">
            {membershipSummary(room.agentIds.length, room.connectedUserNames.length)}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="size-3.5" />
          Add agent
        </Button>
      </div>

      {room.agentIds.length === 0 && room.connectedUserNames.length === 0 ? (
        <p className="text-sm text-foreground-muted">Nobody is in this room yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {room.agentIds.map((agentId) => (
            <ParticipantCard
              key={agentId}
              mark={<AgentMark agentId={agentId} serverId={serverId} remoteById={remoteById} />}
              name={agentNameFor(agentId, serverId, remoteById)}
              detail={agentKindFor(agentId, serverId, remoteById)}
            />
          ))}
          {room.connectedUserNames.map((name) => (
            <ParticipantCard
              key={`user:${name}`}
              mark={
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--fill-2)] text-xs font-medium text-foreground">
                  {name.charAt(0).toUpperCase()}
                </span>
              }
              name={name}
              detail="person"
            />
          ))}
        </div>
      )}

      {adding && <AddAgentPanel serverId={serverId} room={room} onAdded={refresh} />}
    </section>
  );
});

function ParticipantCard({
  mark,
  name,
  detail,
}: {
  mark: React.ReactNode;
  name: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3">
      {mark}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-foreground-muted">{detail}</span>
      </div>
    </div>
  );
}

/**
 * Search this computer's agents and put one in the room.
 *
 * Scoped to agents this install owns, like every other add-an-agent surface:
 * adding somebody else's agent from here would put a room in front of an agent
 * whose owner never agreed to it.
 */
const AddAgentPanel = observer(function AddAgentPanel({
  serverId,
  room,
  onAdded,
}: {
  serverId: string;
  room: RemoteRoomDetail;
  onAdded: () => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = new Set(room.agentIds);
  const { data: remoteAgents } = useRemoteAgents(serverId);
  const remoteById = new Map((remoteAgents ?? []).map((agent) => [agent.id, agent]));
  const query = filter.trim().toLowerCase();
  const candidates = agentsStore
    .agentsOnServer(serverId)
    .filter((agent) => agent.switchAgentId !== null && !members.has(agent.switchAgentId))
    .filter((agent) => query === '' || agent.name.toLowerCase().includes(query));

  async function add(switchAgentId: string) {
    setBusyId(switchAgentId);
    setError(null);
    try {
      await rpc.switchServers.addRoomAgents({
        serverId,
        roomId: room.id,
        agentIds: [switchAgentId],
        direction: 'agents_to_room',
      });
      await onAdded();
    } catch (cause) {
      setError(failureText(cause, 'Could not add the agent to this room.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <InputGroup>
        <InputGroupAddon>
          <Search className="size-3.5 text-foreground-muted" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          placeholder="Search agents on this computer…"
          aria-label="Search agents to add"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear the search"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {error !== null && <p className="text-xs text-destructive">Not added — {error}</p>}

      {candidates.length === 0 ? (
        <p className="px-1 py-2 text-sm text-foreground-muted">
          {query === ''
            ? 'Every agent on this computer is already in this room.'
            : `No agent here matches “${filter.trim()}”.`}
        </p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {candidates.map((agent) => {
            const switchAgentId = agent.switchAgentId as string;
            const busy = busyId === switchAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                disabled={busyId !== null}
                onClick={() => void add(switchAgentId)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--fill)]',
                  busyId !== null && 'cursor-wait'
                )}
              >
                <AgentAvatar
                  name={agent.name}
                  iconUrl={remoteById.get(switchAgentId)?.iconUrl ?? null}
                  size={22}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {agent.name}
                </span>
                <span className="shrink-0 text-xs text-foreground-muted">
                  {providerDisplayName(agent.providerId) ?? 'Agent'}
                </span>
                <span className="shrink-0 text-xs font-medium text-foreground">
                  {busy ? 'Adding…' : 'Add'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

function PanelNotice({
  icon,
  title,
  detail,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="text-foreground-passive">{icon}</div>}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="max-w-md text-xs text-foreground-muted">{detail}</p>}
      {action}
    </div>
  );
}

/** An agent's own picture, beside the human participants' initials discs. */
function AgentMark({
  agentId,
  serverId,
  remoteById,
}: {
  agentId: string;
  serverId: string;
  remoteById: Map<string, RemoteAgentSummary>;
}) {
  const remote = remoteById.get(agentId) ?? null;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center">
      <AgentAvatar
        name={agentNameFor(agentId, serverId, remoteById)}
        iconUrl={remote?.iconUrl ?? null}
        size={26}
      />
    </span>
  );
}

/** This install's record of a Switch agent, which is where its provider is
 * known — the server says what type an agent is, not what runs it here. */
function localAgentFor(switchAgentId: string, serverId: string) {
  return (
    agentsStore.agentsOnServer(serverId).find((a) => a.switchAgentId === switchAgentId) ?? null
  );
}

function agentNameFor(
  switchAgentId: string,
  serverId: string,
  remoteById: Map<string, RemoteAgentSummary>
): string {
  return (
    localAgentFor(switchAgentId, serverId)?.name ?? remoteById.get(switchAgentId)?.name ?? 'Agent'
  );
}

/** What an agent runs, in words: this install's provider when it has one,
 * otherwise the type the server knows it by. */
function agentKindFor(
  switchAgentId: string,
  serverId: string,
  remoteById: Map<string, RemoteAgentSummary>
): string {
  const providerId = localAgentFor(switchAgentId, serverId)?.providerId ?? null;
  const knownType = remoteById.get(switchAgentId)?.knownAgentType ?? null;
  return providerDisplayName(providerId) ?? providerDisplayName(knownType) ?? 'agent';
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { chatMembersQueryKey, workspaceRosterQuery } from '@renderer/features/chats/chat-people';
import { confirmLeaveChat } from '@renderer/features/chats/components/chat-actions';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatFailure } from '@renderer/features/chats/stores/chat-errors';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import type { RoomPermissions } from '@renderer/features/switch-servers/room-permissions';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import {
  agentParticipant,
  type Participant,
  personParticipant,
} from '@renderer/lib/components/participant-search';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Input } from '@renderer/lib/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import { type ChatSummary, chatAgentLabel } from '@shared/core/chats/chats';
import { knownAgentTypeDisplayName } from '@shared/core/providers/agent-provider-registry';
import { runsOnThisComputer } from '@shared/core/switch-servers/switch-servers';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import { administersWorkspace } from '@shared/core/workspaces/workspaces';
import { roomAgentPresence } from './room-agent-presence';
import { channelOnDeleteSummary } from './room-delete-wording';
import { addableAgents, addablePeople, membershipSummary, roomTitle } from './room-labels';
import { openRoomChannel } from './room-links';
import {
  AgentMark,
  agentKindFor,
  agentNameFor,
  localAgentFor,
  PersonMark,
  roomDetailKey,
} from './room-participants';
import {
  AccessAndGroupFields,
  ArchiveRoomSection,
  RolesSection,
  RoomInfoSection,
} from './room-settings-sections';

/** One room read from its server; `workspaceId` is null until the room list has loaded. */
function useRoomDetail(roomId: string) {
  const workspaceId = switchRoomsStore.roomWorkspaceId(roomId);
  const query = useQuery({
    queryKey: roomDetailKey(workspaceId ?? '', roomId),
    queryFn: () => rpc.workspaces.getRoomDetail({ workspaceId: workspaceId as string, roomId }),
    enabled: workspaceId !== null && !opensAsConsoleChat(roomId),
  });
  return { workspaceId, query };
}

/**
 * A group chat's settings, read from the chat rather than the room list, which
 * an invited person is not on. Description and instructions are the room's,
 * shown only to someone who may manage the chat and so may read and write them.
 */
const ChatConfiguration = observer(function ChatConfiguration({
  serverId,
  chat,
}: {
  serverId: string;
  chat: ChatSummary;
}) {
  const workspaceId = switchRoomsStore.roomWorkspaceId(chat.roomId) ?? workspacesStore.activeId;
  const detail = useQuery({
    queryKey: roomDetailKey(workspaceId ?? '', chat.roomId),
    queryFn: () =>
      rpc.workspaces.getRoomDetail({ workspaceId: workspaceId as string, roomId: chat.roomId }),
    enabled: workspaceId !== null && chat.canManage,
  });
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-10 py-8">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold text-foreground">{chat.name}</h1>
          <p className="text-sm text-foreground-muted">Group chat in Switch Console</p>
        </div>
        {workspaceId !== null && detail.data && (
          <GeneralSection key={chat.roomId} workspaceId={workspaceId} room={detail.data} />
        )}
        {detail.isError && (
          <p className="text-xs text-foreground-muted">
            {failureText(detail.error, 'Could not read this chat’s description and instructions.')}
          </p>
        )}
        <ChatParticipantsSection serverId={serverId} workspaceId={workspaceId} chat={chat} />
        {workspaceId !== null && detail.data && (
          <>
            <RolesSection
              workspaceId={workspaceId}
              room={detail.data}
              permissions={{ canWrite: chat.canManage, canManage: chat.canManage }}
            />
            <RoomInfoSection room={detail.data} />
          </>
        )}
        <section className="border-t border-border pt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">Leave room</h3>
              <p className="text-xs text-foreground-muted">
                You stop seeing its messages; someone who manages it can add you back.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => confirmLeaveChat(serverId, chat)}
            >
              Leave room…
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
});

/** Who is in a group chat; a manager adds and removes agents and people through the chat. */
const ChatParticipantsSection = observer(function ChatParticipantsSection({
  serverId,
  workspaceId,
  chat,
}: {
  serverId: string;
  workspaceId: string | null;
  chat: ChatSummary;
}) {
  const queryClient = useQueryClient();
  const roomId = chat.roomId;
  const membersKey = chatMembersQueryKey(serverId, chat);
  // Adding to a chat makes it a group, which the server offers only with its group_chats flag.
  const groupChats = useFeatureFlags(serverId).group_chats;
  const canAdd = chat.canManage && groupChats;
  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => rpc.chats.members(serverId, roomId),
  });
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = members.data ?? [];
  const agentIds = chat.agents.map((agent) => agent.id);

  async function remove(id: string, action: () => Promise<void>) {
    setRemoving(id);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(`Not removed — ${chatFailure(cause).message}`);
    } finally {
      setRemoving(null);
    }
  }
  const manage: ManageParticipants | null = chat.canManage
    ? {
        removing,
        removeAgent: (agentId) =>
          void remove(agentId, async () => {
            await rpc.chats.removeAgent({ serverId, roomId, agentId });
            chatsStore.dropAgent(roomId, agentId);
          }),
        // The owner stays: there is no one to hand the chat to.
        removePerson: (userId) =>
          people.find((person) => person.userId === userId)?.isOwner
            ? null
            : () =>
                void remove(userId, async () => {
                  await rpc.chats.removeMember({ serverId, roomId, userId });
                  await queryClient.invalidateQueries({ queryKey: membersKey });
                }),
      }
    : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Participants</h2>
          <span className="text-xs text-foreground-muted">
            {membershipSummary(agentIds.length, people.length)}
          </span>
        </div>
        {canAdd && (
          <Button
            variant="outline"
            size="sm"
            aria-controls={ADD_PARTICIPANT_INPUT}
            // Focusing the field opens its results.
            onClick={() => document.getElementById(ADD_PARTICIPANT_INPUT)?.focus()}
          >
            <Plus className="size-3.5" />
            Add participants
          </Button>
        )}
      </div>

      {canAdd && (
        <ChatAddParticipantPanel
          serverId={serverId}
          workspaceId={workspaceId}
          chat={chat}
          memberIds={new Set(people.map((person) => person.userId))}
          onAddedPeople={(next) => queryClient.setQueryData(membersKey, next)}
        />
      )}

      {members.isError && (
        <p className="text-xs text-destructive">{chatFailure(members.error).message}</p>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}

      <ParticipantList
        workspaceId={workspaceId}
        agentIds={agentIds}
        agentNames={new Map(chat.agents.map((agent) => [agent.id, chatAgentLabel(agent)]))}
        people={people.map((person) => ({
          id: person.userId,
          name: person.name,
          detail: person.isOwner ? 'owner' : 'member',
        }))}
        manage={manage}
      />
    </section>
  );
});

/** Adds a picked participant through the chats API: an agent to the chat, a person as a member. */
export async function addToChat(
  api: Pick<typeof rpc.chats, 'addAgent' | 'addMember'>,
  serverId: string,
  roomId: string,
  participant: Participant
): Promise<
  | { kind: 'agent'; chat: ChatSummary }
  | { kind: 'person'; members: Awaited<ReturnType<typeof rpc.chats.addMember>> }
> {
  if (participant.kind === 'agent')
    return {
      kind: 'agent',
      chat: await api.addAgent({ serverId, roomId, agentId: participant.id }),
    };
  return {
    kind: 'person',
    members: await api.addMember({ serverId, roomId, userId: participant.id }),
  };
}

const ADD_PARTICIPANT_INPUT = 'chat-add-participant';

/** The Add button's label: how many it adds once there is more than one. */
export function addLabel(count: number): string {
  return count > 1 ? `Add ${count}` : 'Add';
}

/**
 * Adds each pick in turn through the chats API, telling `onAdded` of each
 * success; resolves to the picks the server refused, each with its reason.
 * One at a time, so each add sees the chat as the one before left it.
 */
export async function addAllToChat(
  api: Pick<typeof rpc.chats, 'addAgent' | 'addMember'>,
  serverId: string,
  roomId: string,
  picks: Participant[],
  onAdded: (added: Awaited<ReturnType<typeof addToChat>>) => void
): Promise<{ participant: Participant; reason: string }[]> {
  const failures: { participant: Participant; reason: string }[] = [];
  for (const participant of picks) {
    try {
      onAdded(await addToChat(api, serverId, roomId, participant));
    } catch (cause) {
      failures.push({ participant, reason: chatFailure(cause).message });
    }
  }
  return failures;
}

/**
 * The New room dialog's participant field: picks gather as chips, and Add
 * puts them all in the chat. It offers the agents the viewer may add and the
 * people on the roster, never someone already in the chat.
 */
const ChatAddParticipantPanel = observer(function ChatAddParticipantPanel({
  serverId,
  workspaceId,
  chat,
  memberIds,
  onAddedPeople,
}: {
  serverId: string;
  workspaceId: string | null;
  chat: ChatSummary;
  /** The people in the chat, the viewer included. */
  memberIds: Set<string>;
  onAddedPeople: (members: Awaited<ReturnType<typeof rpc.chats.addMember>>) => void;
}) {
  const tenantId = chatsStore.tenantId;
  const agents = useWorkspaceAgents(workspaceId);
  const roster = useQuery(workspaceRosterQuery(serverId, tenantId));
  const allowed = useQuery({
    // Keyed by the chat's agents, so adding or removing one asks again.
    queryKey: [
      'chat-agent-candidates',
      serverId,
      workspaceId,
      chat.roomId,
      chat.agents.map((agent) => agent.id).join(','),
    ],
    queryFn: () => rpc.chats.agentCandidates({ serverId, roomId: chat.roomId }),
  });
  const [picked, setPicked] = useState<Participant[]>([]);
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  const candidates = [
    ...addableAgents(agents.data ?? [], allowed.data ?? []).map((agent) =>
      agentParticipant(agent, knownAgentTypeDisplayName(agent.knownAgentType) ?? 'Agent')
    ),
    ...addablePeople(roster.data ?? [], memberIds).map(personParticipant),
  ];

  async function addAll() {
    if (adding || picked.length === 0) return;
    setAdding(true);
    setRefused([]);
    const failures = await addAllToChat(rpc.chats, serverId, chat.roomId, picked, (added) => {
      if (added.kind === 'agent') chatsStore.add(serverId, added.chat);
      else onAddedPeople(added.members);
    });
    setPicked(failures.map((failure) => failure.participant));
    setRefused(
      failures.map(({ participant, reason }) => `${participant.name} was not added — ${reason}`)
    );
    setAdding(false);
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <ParticipantPicker
            inputId={ADD_PARTICIPANT_INPUT}
            autoFocus={false}
            busy={adding}
            overlay
            candidates={candidates}
            picked={picked}
            onChange={setPicked}
            serverId={serverId}
            loading={
              agents.isPending || allowed.isPending || (tenantId !== null && roster.isPending)
            }
          />
        </div>
        <ConfirmButton
          size="sm"
          className="h-8 shrink-0"
          disabled={picked.length === 0 || adding}
          onClick={() => void addAll()}
        >
          {addLabel(picked.length)}
        </ConfirmButton>
      </div>
      {refused.map((line) => (
        <p key={line} className="text-xs text-destructive">
          {line}
        </p>
      ))}
      {(agents.isError || allowed.isError) && (
        <p className="text-xs text-destructive">
          {failureText(agents.error ?? allowed.error, 'Could not list the agents.')}
        </p>
      )}
      {tenantId === null ? (
        <p className="text-xs text-destructive">
          This workspace has no tenant to list people from.
        </p>
      ) : (
        roster.isError && (
          <p className="text-xs text-destructive">
            {failureText(roster.error, 'Could not list the people.')}
          </p>
        )
      )}
      <InviteHint workspaceId={workspaceId} canInvite={canInvite(serverId, workspaceId)} />
    </div>
  );
});

/** Whether the viewer may invite people to the workspace, as the workspace menu decides it. */
function canInvite(serverId: string, workspaceId: string | null): boolean {
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  const server = switchServersStore.servers.find((each) => each.id === serverId) ?? null;
  return (
    workspace !== null &&
    server !== null &&
    administersWorkspace(workspace) &&
    !runsOnThisComputer(server)
  );
}

/** Where to go for someone the roster does not have yet. */
export function InviteHint({
  workspaceId,
  canInvite,
}: {
  workspaceId: string | null;
  canInvite: boolean;
}) {
  const showInvitePeopleModal = useShowModal('invitePeopleModal');
  return (
    <p className="px-1 text-xs text-foreground-muted">
      Don&apos;t see someone?{' '}
      {canInvite && workspaceId !== null ? (
        <button
          type="button"
          className="cursor-pointer underline hover:text-foreground"
          onClick={() => showInvitePeopleModal({ workspaceId })}
        >
          Invite them to the workspace
        </button>
      ) : (
        'Ask a workspace admin to invite them.'
      )}
    </p>
  );
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
  const { workspaceId, query } = useRoomDetail(roomId);
  const chat = chatsStore.chat(roomId);

  if (chat && chatsStore.serverId && isConsoleGroupChatSummary(chat)) {
    return <ChatConfiguration serverId={chatsStore.serverId} chat={chat} />;
  }
  if (opensAsConsoleChat(roomId)) {
    return <PanelNotice title="You no longer have access to this chat." />;
  }

  if (workspaceId === null) {
    return <PanelNotice title="This room’s workspace is still loading." />;
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
  const permissions = switchRoomsStore.roomPermissions(workspaceId, room);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1080px] gap-10 px-10 py-8">
        <SettingsIndex />
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <RoomHeading serverId={switchRoomsStore.roomServerId(roomId)} room={room} />
          {room.archived && (
            <Notice icon={<Archive className="size-3.5" />}>
              This room is archived. It is out of the room lists and agents cannot join it.
            </Notice>
          )}
          {!permissions.canWrite && (
            <Notice icon={<Lock className="size-3.5" />}>
              Only {room.ownerName ?? 'the room’s owner'} or a workspace admin can change this
              room’s settings.
            </Notice>
          )}
          {/* Keyed on the room so the drafts below belong to the room on screen:
              switching rooms starts a fresh form rather than carrying half-typed
              text across. */}
          <GeneralSection
            key={room.id}
            workspaceId={workspaceId}
            room={room}
            readOnly={!permissions.canWrite}
          />
          <AccessAndGroupFields workspaceId={workspaceId} room={room} permissions={permissions} />
          <ParticipantsSection workspaceId={workspaceId} room={room} permissions={permissions} />
          <RolesSection workspaceId={workspaceId} room={room} permissions={permissions} />
          <RoomInfoSection room={room} />
          <section
            id="room-settings-archive"
            className="flex flex-col gap-5 border-t border-border pt-6"
          >
            <ArchiveRoomSection workspaceId={workspaceId} room={room} permissions={permissions} />
            <DeleteRoomSection workspaceId={workspaceId} room={room} />
          </section>
        </div>
      </div>
    </div>
  );
});

const SETTINGS_SECTIONS = [
  ['room-settings-general', 'General'],
  ['room-settings-participants', 'Participants'],
  ['room-settings-roles', 'Roles'],
  ['room-settings-info', 'Room info'],
  ['room-settings-archive', 'Archive & delete'],
] as const;

/** The page's sections, to jump between; it stays put while the page scrolls. */
function SettingsIndex() {
  return (
    <nav
      aria-label="Room settings sections"
      className="sticky top-0 hidden w-[150px] shrink-0 self-start pt-1 lg:block"
    >
      {SETTINGS_SECTIONS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className="block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-sm text-foreground-muted hover:bg-background-1 hover:text-foreground"
          onClick={() =>
            document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-background-secondary px-3 py-2 text-xs text-foreground-muted">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/**
 * Deleting the room, last on its page and below a rule.
 *
 * Absent entirely for anyone who may not delete it, rather than shown disabled:
 * a greyed control invites you to go and find the permission, and here there is
 * none to find — the room is someone else's.
 */
const DeleteRoomSection = observer(function DeleteRoomSection({
  workspaceId,
  room,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
}) {
  const showDeleteRoomModal = useShowModal('deleteRoomModal');
  const { navigate } = useNavigate();

  if (!switchRoomsStore.canDeleteRoom(workspaceId, room)) return null;

  return (
    <section className="border-t border-border pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-foreground">Delete room</h3>
          <p className="text-xs text-foreground-muted">
            Removes the room and its conversation for everyone in it.
            {room.bridgeType
              ? ` ${channelOnDeleteSummary(bridgePlatformLabel(room.bridgeType), room.channelOnDelete) ?? ''}`
              : ''}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={() =>
            showDeleteRoomModal({
              workspaceId,
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

function RoomHeading({ serverId, room }: { serverId: string | null; room: RemoteRoomDetail }) {
  const platform = bridgePlatformLabel(room.bridgeType);
  const { navigate } = useNavigate();
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
      <div className="flex shrink-0 items-center gap-2">
        {serverId !== null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('templateCapture', { serverId, roomId: room.id })}
          >
            <FileText className="size-3.5" />
            Capture as template
          </Button>
        )}
        {room.externalChannelUrl && (
          <>
            {room.bridgeDisplayName && (
              <span className="rounded-md bg-[var(--fill)] px-2.5 py-1.5 text-xs text-foreground-muted">
                {room.bridgeDisplayName}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => openRoomChannel(room.id)}>
              <ExternalLink className="size-3.5" />
              Open in {platform}
            </Button>
          </>
        )}
      </div>
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
function GeneralSection({
  workspaceId,
  room,
  readOnly = false,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  /** For someone who may read the room but not change it: the fields show, and do not take edits. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const savedName = room.name;
  const savedDescription = room.description;
  const savedInstructions = room.instructions ?? '';
  const [name, setName] = useState(savedName);
  const [description, setDescription] = useState(savedDescription);
  const [instructions, setInstructions] = useState(savedInstructions);
  const [state, setState] = useState<SaveState>({ phase: 'idle' });

  const renamed = name.trim() !== savedName;
  const dirty = renamed || description !== savedDescription || instructions !== savedInstructions;

  async function save() {
    setState({ phase: 'saving' });
    try {
      const updated = await rpc.workspaces.updateRoom({
        workspaceId,
        roomId: room.id,
        ...(renamed ? { name: name.trim() } : {}),
        description,
        instructions,
      });
      queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
      setName(updated.name);
      setState({ phase: 'saved' });
      // The name shows in the sidebar, the room lists and the chat's title.
      if (renamed) {
        void refreshSidebarRoomState(true);
        void chatsStore.refreshSummaries();
      }
    } catch (cause) {
      setState({ phase: 'failed', message: failureText(cause, 'Could not save the change.') });
    }
  }

  return (
    <section id="room-settings-general" className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">General</h2>

      <Field label="Name" hint="What everyone in the room sees it called.">
        <Input
          className="h-9"
          aria-label="Name"
          disabled={readOnly}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>
      <LinkedChannelName
        workspaceId={workspaceId}
        room={room}
        onSynced={(updated) => setName(updated.name)}
      />

      <Field
        label="Description"
        hint="Helps other people and agents understand what this room is for."
      >
        <Input
          className="h-9"
          placeholder="What this room is for"
          disabled={readOnly}
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
          disabled={readOnly}
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>

      {/* The status sits beside the button rather than under a field: one
          request covers both, so there is one answer to report. */}
      <div className={cn('flex items-center justify-end gap-3', readOnly && 'hidden')}>
        <SaveStatus state={state} dirty={dirty} />
        <Button
          type="button"
          size="sm"
          disabled={!dirty || name.trim() === '' || state.phase === 'saving'}
          onClick={() => void save()}
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

/**
 * The channel a bridged room is linked to, when it is called something else
 * there, with a way for someone who manages the room to name it after the
 * channel, which it then follows when the channel is renamed.
 */
const LinkedChannelName = observer(function LinkedChannelName({
  workspaceId,
  room,
  onSynced,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  onSynced: (updated: RemoteRoomDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = room.linkedChannelName;
  if (!channel || channel === room.name || `#${channel}` === room.name) return null;
  const canSync = switchRoomsStore.canDeleteRoom(workspaceId, room);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const updated = await rpc.workspaces.syncRoomName({ workspaceId, roomId: room.id });
      queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
      onSynced(updated);
      void refreshSidebarRoomState(true);
      void chatsStore.refreshSummaries();
    } catch (cause) {
      setError(failureText(cause, 'Could not name the room after its channel.'));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
      <span>Linked channel: #{channel}</span>
      {canSync && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? 'Renaming…' : 'Use channel name'}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
});

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
 * Who is in the room: each agent with what it is doing here, whether it is told
 * when someone joins, and a way to take it out; then the people. Someone who may
 * write to the room adds agents — any agent on the server, as the gateway
 * offers — and invites people from the messaging app.
 */
const ParticipantsSection = observer(function ParticipantsSection({
  workspaceId,
  room,
  permissions,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  permissions: RoomPermissions;
}) {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<'agent' | 'people' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showAddAgentsToRoomModal = useShowModal('addAgentsToRoomModal');
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((agent) => [agent.id, agent]));
  const detailQueryKey = roomDetailKey(workspaceId, room.id);
  const canWrite = permissions.canWrite;
  const canInvitePeople = canWrite && room.bridgeId !== null;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: detailQueryKey });
    await switchRoomsStore.refreshRoomState();
  }

  async function act(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(failureText(cause, fallback));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="room-settings-participants" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Participants</h2>
          <span className="text-xs text-foreground-muted">
            {membershipSummary(room.agentIds.length, room.connectedUserNames.length)}
          </span>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => showAddAgentsToRoomModal({ roomId: room.id })}
            >
              <FileText className="size-3.5" />
              From a template
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={panel === 'agent'}
              onClick={() => setPanel(panel === 'agent' ? null : 'agent')}
            >
              <Plus className="size-3.5" />
              Add agent
            </Button>
            {canInvitePeople && (
              <Button
                variant="outline"
                size="sm"
                aria-expanded={panel === 'people'}
                onClick={() => setPanel(panel === 'people' ? null : 'people')}
              >
                <Plus className="size-3.5" />
                Add people
              </Button>
            )}
          </div>
        )}
      </div>

      {panel === 'agent' && (
        <AddAgentPanel workspaceId={workspaceId} room={room} onAdded={refresh} />
      )}
      {panel === 'people' && room.bridgeId !== null && (
        <AddPeoplePanel workspaceId={workspaceId} room={room} bridgeId={room.bridgeId} />
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}

      {room.agentIds.length === 0 && room.connectedUserNames.length === 0 ? (
        <p className="text-sm text-foreground-muted">Nobody is in this room yet.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {room.agentIds.map((agentId) => {
            const name = agentNameFor(agentId, workspaceId, remoteById);
            const presence = roomAgentPresence(room.agentStatuses[agentId]);
            const role = room.roles.find((each) => each.heldBy.includes(name));
            const listening = room.joinEventListeners.includes(agentId);
            return (
              <div key={agentId} className="flex items-center gap-3 px-3.5 py-2.5">
                <AgentMark agentId={agentId} workspaceId={workspaceId} remoteById={remoteById} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{name}</span>
                  <span className="truncate text-xs text-foreground-muted">
                    {[
                      agentKindFor(agentId, workspaceId, remoteById),
                      room.agentStatuses[agentId] === undefined ? null : presence.label,
                      role ? `role: ${role.name}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <label
                  className="flex shrink-0 items-center gap-2 text-xs text-foreground-muted"
                  title="Tell this agent when someone joins the room"
                >
                  Notify on join
                  <Switch
                    size="sm"
                    checked={listening}
                    disabled={!canWrite || busy === `join:${agentId}`}
                    aria-label={`Tell ${name} when someone joins`}
                    onCheckedChange={(next) =>
                      void act(
                        `join:${agentId}`,
                        async () => {
                          queryClient.setQueryData(
                            detailQueryKey,
                            await rpc.workspaces.setRoomAgentJoinEvents({
                              workspaceId,
                              roomId: room.id,
                              agentId,
                              receivesJoinEvents: next,
                            })
                          );
                        },
                        'Could not change the join notification.'
                      )
                    }
                  />
                </label>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    disabled={busy === `remove:${agentId}`}
                    onClick={() =>
                      void act(
                        `remove:${agentId}`,
                        async () => {
                          await rpc.workspaces.removeRoomAgent({
                            workspaceId,
                            roomId: room.id,
                            agentId,
                          });
                          await refresh();
                        },
                        `Could not remove ${name}.`
                      )
                    }
                  >
                    {busy === `remove:${agentId}` ? <Loader2 className="animate-spin" /> : <X />}
                  </Button>
                )}
              </div>
            );
          })}
          {room.connectedUserNames.map((person) => (
            <div key={`user:${person}`} className="flex items-center gap-3 px-3.5 py-2.5">
              <PersonMark name={person} size="md" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{person}</span>
              <span className="shrink-0 text-xs text-foreground-muted">person</span>
            </div>
          ))}
        </div>
      )}
      {room.bridgeId !== null && room.connectedUserNames.length > 0 && (
        <p className="text-xs text-foreground-muted">
          People are those Switch has seen in the channel or added to it. The channel may have more.
        </p>
      )}
    </section>
  );
});

/**
 * Invite people to a bridged room from the messaging app's users Switch knows.
 * The server does not say who it could not add, so the names asked for are
 * compared with the room's people afterwards and any missing are named.
 */
const AddPeoplePanel = observer(function AddPeoplePanel({
  workspaceId,
  room,
  bridgeId,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  bridgeId: string;
}) {
  const queryClient = useQueryClient();
  const [notAdded, setNotAdded] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['bridge-user-names', workspaceId, bridgeId],
    queryFn: () => rpc.workspaces.listBridgeUserNames({ workspaceId, bridgeId }),
  });
  const present = new Set(room.connectedUserNames);
  return (
    <>
      <AddParticipantPanel
        noun="person"
        searchPlaceholder={`Search people on ${room.bridgeDisplayName ?? 'the messaging app'}…`}
        allInText="Everyone Switch knows on this messaging app is already in the room."
        loading={users.isPending}
        loadError={users.isError ? failureText(users.error, 'Could not list the people.') : null}
        candidates={(users.data ?? [])
          .filter((name) => !present.has(name))
          .map((name) => ({
            id: name,
            name,
            mark: <PersonMark name={name} size="sm" />,
            detail: 'person',
          }))}
        footer={
          <p className="px-1 text-xs text-foreground-muted">
            Only people Switch has seen on this messaging app are listed.
          </p>
        }
        onAdd={async (name) => {
          setNotAdded(null);
          const updated = await rpc.workspaces.addRoomUsers({
            workspaceId,
            roomId: room.id,
            userNames: [name],
          });
          queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
          if (!updated.connectedUserNames.includes(name))
            setNotAdded(
              `${name} was not added. The messaging app may not have let Switch invite them.`
            );
        }}
      />
      {notAdded !== null && <p className="text-xs text-destructive">{notAdded}</p>}
    </>
  );
});

type Person = { id: string; name: string; detail: string };

/** Removal from the cards, for someone who may manage the members; `removePerson` is null for one who cannot be removed. */
type ManageParticipants = {
  removing: string | null;
  removeAgent: (agentId: string) => void;
  removePerson: (id: string) => (() => void) | null;
};

/** The room's members as cards, agents first. `agentNames` names agents the caller already knows. */
const ParticipantList = observer(function ParticipantList({
  workspaceId,
  agentIds,
  agentNames,
  people,
  manage,
}: {
  workspaceId: string | null;
  agentIds: string[];
  agentNames: Map<string, string>;
  people: Person[];
  manage: ManageParticipants | null;
}) {
  // Names for agents belonging to other installs, which this computer has no
  // local record of. Shares its key with the rest of the app, so it is usually
  // already in hand.
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((a) => [a.id, a]));
  return agentIds.length === 0 && people.length === 0 ? (
    <p className="text-sm text-foreground-muted">Nobody is in this room yet.</p>
  ) : (
    <div className="grid grid-cols-2 gap-2.5">
      {agentIds.map((agentId) => (
        <ParticipantCard
          key={agentId}
          mark={<AgentMark agentId={agentId} workspaceId={workspaceId} remoteById={remoteById} />}
          name={agentNames.get(agentId) ?? agentNameFor(agentId, workspaceId, remoteById)}
          detail={agentKindFor(agentId, workspaceId, remoteById)}
          removing={manage?.removing === agentId}
          onRemove={manage && (() => manage.removeAgent(agentId))}
        />
      ))}
      {people.map((person) => (
        <ParticipantCard
          key={person.id}
          mark={<PersonMark name={person.name} size="md" />}
          name={person.name}
          detail={person.detail}
          removing={manage?.removing === person.id}
          onRemove={manage?.removePerson(person.id) ?? null}
        />
      ))}
    </div>
  );
});

function ParticipantCard({
  mark,
  name,
  detail,
  removing,
  onRemove,
}: {
  mark: React.ReactNode;
  name: string;
  detail: string;
  removing: boolean;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3">
      {mark}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-foreground-muted">{detail}</span>
      </div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? <Loader2 className="animate-spin" /> : <X />}
        </Button>
      )}
    </div>
  );
}

type Candidate = { id: string; name: string; mark: React.ReactNode; detail: string };

/**
 * A searchable list of who could join, each row adding one. A refusal is shown
 * in the words `onAdd` threw with.
 */
function AddParticipantPanel({
  noun,
  searchPlaceholder,
  allInText,
  loading,
  loadError,
  candidates,
  footer,
  onAdd,
}: {
  noun: string;
  searchPlaceholder: string;
  allInText: string;
  loading: boolean;
  loadError: string | null;
  candidates: Candidate[];
  /** Under the list, such as where to go for someone who is not in it. */
  footer: React.ReactNode;
  onAdd: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const shown = candidates.filter(
    (candidate) =>
      query === '' || `${candidate.name}\n${candidate.detail}`.toLowerCase().includes(query)
  );

  async function add(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onAdd(id);
    } catch (cause) {
      setError(failureText(cause, `Could not add the ${noun}.`));
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
          placeholder={searchPlaceholder}
          aria-label={`Search for a ${noun} to add`}
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
      {loadError !== null && <p className="text-xs text-destructive">{loadError}</p>}

      {loading ? (
        <p className="px-1 py-2 text-sm text-foreground-muted">Loading…</p>
      ) : shown.length === 0 ? (
        loadError === null && (
          <p className="px-1 py-2 text-sm text-foreground-muted">
            {query === '' ? allInText : `No ${noun} here matches “${filter.trim()}”.`}
          </p>
        )
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {shown.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              disabled={busyId !== null}
              onClick={() => void add(candidate.id)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-3 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--fill)]',
                busyId !== null && 'cursor-wait'
              )}
            >
              {candidate.mark}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {candidate.name}
              </span>
              <span className="shrink-0 text-xs text-foreground-muted">{candidate.detail}</span>
              <span className="shrink-0 text-xs font-medium text-foreground">
                {busyId === candidate.id ? 'Adding…' : 'Add'}
              </span>
            </button>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}

/**
 * Search the server's agents and put one in the room — any agent the viewer can
 * see, as the gateway offers. Whether an agent then answers anyone in the room
 * is still up to its own addressing rules.
 */
const AddAgentPanel = observer(function AddAgentPanel({
  workspaceId,
  room,
  onAdded,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  onAdded: () => Promise<void>;
}) {
  const members = new Set(room.agentIds);
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const serverId = workspacesStore.serverIdFor(workspaceId);
  return (
    <AddParticipantPanel
      noun="agent"
      footer={null}
      searchPlaceholder="Search agents…"
      allInText="Every agent on this server is already in this room."
      loading={remoteAgents.isPending}
      loadError={
        remoteAgents.isError ? failureText(remoteAgents.error, 'Could not list the agents.') : null
      }
      candidates={(remoteAgents.data ?? [])
        .filter((agent) => !members.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          mark: (
            <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} serverId={serverId} size={22} />
          ),
          detail: [
            localAgentFor(agent.id, workspaceId)
              ? 'yours'
              : agent.ownerName
                ? `${agent.ownerName}’s`
                : null,
            agentKindFor(agent.id, workspaceId, new Map([[agent.id, agent]])),
          ]
            .filter(Boolean)
            .join(' · '),
        }))}
      onAdd={async (agentId) => {
        await rpc.workspaces.addRoomAgents({
          workspaceId,
          roomId: room.id,
          agentIds: [agentId],
          direction: 'agents_to_room',
        });
        await onAdded();
      }}
    />
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

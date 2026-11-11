import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Loader2, MoreHorizontal, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { chatMembersQueryKey } from '@renderer/features/chats/chat-people';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatFailure } from '@renderer/features/chats/stores/chat-errors';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import { chatAgentLabel } from '@shared/core/chats/chats';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import { AddAgentPanel, AddPeoplePanel, ChatAddParticipantPanel } from './room-add-participants';
import { roomAgentPresence } from './room-agent-presence';
import { linkedNamesByUsername } from './room-labels';
import { roomInviteability } from './room-membership';
import {
  AgentMark,
  agentNameFor,
  PersonMark,
  roomDetailKey,
  useRoomDetail,
} from './room-participants';

const TONE_CLASS = {
  live: 'bg-foreground-success',
  idle: 'bg-foreground-warning',
  off: 'bg-[var(--fg-passive)]',
} as const;

/** What the viewer may change about who is in the room, and how. */
type RosterControls = {
  /** Opens adding agents, or null for someone who may not add them. */
  addAgents: (() => void) | null;
  /** Opens adding people, or null where they cannot be added. */
  addPeople: (() => void) | null;
  /** Why people cannot be added here, for someone who could otherwise. */
  peopleNote: string | null;
  removeAgent: ((agentId: string) => Promise<void>) | null;
  /** Null for someone who may not remove people, or for a person who cannot be removed. */
  removePerson: (key: string) => (() => Promise<void>) | null;
  /** Whether the agent is told when someone joins, and the way to change it; null where it cannot be. */
  joinEvents: {
    listening: (agentId: string) => boolean;
    set: (agentId: string, on: boolean) => Promise<void>;
  } | null;
};

const NO_CONTROLS: RosterControls = {
  addAgents: null,
  addPeople: null,
  peopleNote: null,
  removeAgent: null,
  removePerson: () => null,
  joinEvents: null,
};

/**
 * Who is in the room, beside it on every tab and on every platform: the
 * agents and what each is doing here, and the people. Whoever may change the
 * room adds and removes them here too. The room's settings and resources are
 * its tabs, so nothing else lives in this column.
 */
export const RoomSidePanel = observer(function RoomSidePanel({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const chat = chatsStore.chat(roomId);
  const consoleChat = opensAsConsoleChat(roomId);
  const workspaceId =
    switchRoomsStore.roomWorkspaceId(roomId) ?? (chat ? workspacesStore.activeId : null);
  const serverId =
    switchRoomsStore.roomServerId(roomId) ?? (chat ? chatsStore.serverId : null) ?? null;
  const groupChats = useFeatureFlags(serverId).group_chats;
  const showAddAgentsToRoomModal = useShowModal('addAgentsToRoomModal');
  const [adding, setAdding] = useState<'agents' | 'people' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Anyone taking part may read the room, so this answers for a chat's members too.
  const detail = useRoomDetail(workspaceId, roomId, true);
  const membersKey = chat && serverId ? chatMembersQueryKey(serverId, chat) : ['no-chat-members'];
  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => rpc.chats.members(serverId as string, roomId),
    enabled: consoleChat && chat !== null && serverId !== null,
  });

  const room = detail.data ?? null;
  const bridgeId = consoleChat ? null : (room?.bridgeId ?? null);
  // Who linked each username, to name them beside it. Shares the Add people
  // panel's cache; if it cannot be read the usernames are shown alone.
  const bridgePeople = useQuery({
    queryKey: ['bridge-people', workspaceId, bridgeId],
    queryFn: () =>
      rpc.workspaces.listBridgePeople({
        workspaceId: workspaceId as string,
        bridgeId: bridgeId as string,
      }),
    enabled: workspaceId !== null && bridgeId !== null,
  });
  const linkedNames = linkedNamesByUsername(bridgePeople.data ?? []);
  // A room that could not be read is not an empty one: say so, rather than "no agents yet".
  const unreadable = !consoleChat && detail.isError;
  const agentIds = chat ? chat.agents.map((agent) => agent.id) : (room?.agentIds ?? []);
  const chatNames = new Map((chat?.agents ?? []).map((agent) => [agent.id, chatAgentLabel(agent)]));
  const people = consoleChat
    ? (members.data ?? []).map((member) => ({
        key: member.userId,
        name: member.name,
        fullName: null,
        detail: member.isOwner ? 'owner' : null,
        isOwner: member.isOwner,
      }))
    : (room?.connectedUserNames ?? []).map((name) => ({
        key: name,
        name,
        fullName: linkedNames.get(name) ?? null,
        detail: null,
        isOwner: false,
      }));

  async function refreshRoom() {
    await queryClient.invalidateQueries({ queryKey: roomDetailKey(workspaceId ?? '', roomId) });
    await switchRoomsStore.refreshRoomState();
  }

  let controls = NO_CONTROLS;
  if (consoleChat && chat && serverId && isConsoleGroupChatSummary(chat) && chat.canManage) {
    controls = {
      ...NO_CONTROLS,
      // Adding to a chat makes it a group, which the server offers only with group chats on.
      addAgents: groupChats ? () => setAdding('agents') : null,
      removeAgent: async (agentId) => {
        await rpc.chats.removeAgent({ serverId, roomId, agentId });
        chatsStore.dropAgent(roomId, agentId);
      },
      // The owner stays: there is no one to hand the chat to.
      removePerson: (key) =>
        people.find((person) => person.key === key)?.isOwner
          ? null
          : async () => {
              await rpc.chats.removeMember({ serverId, roomId, userId: key });
              await queryClient.invalidateQueries({ queryKey: membersKey });
            },
    };
  } else if (!consoleChat && room && workspaceId) {
    const permissions = switchRoomsStore.roomPermissions(workspaceId, room);
    const inviteability = roomInviteability(room, bridgePlatformLabel(room.bridgeType));
    if (permissions.canWrite) {
      // A direct or group conversation's platform fixes who is in it.
      const members = permissions.canChangeMembers;
      controls = {
        addAgents: members ? () => setAdding('agents') : null,
        addPeople: members && inviteability.canInvite ? () => setAdding('people') : null,
        peopleNote: inviteability.canInvite ? null : inviteability.reason,
        removeAgent: members
          ? async (agentId) => {
              await rpc.workspaces.removeRoomAgent({ workspaceId, roomId, agentId });
              await refreshRoom();
            }
          : null,
        // Switch only knows the people it saw or added; it cannot take them out of a channel.
        removePerson: () => null,
        joinEvents: {
          listening: (agentId) => room.joinEventListeners.includes(agentId),
          set: async (agentId, on) => {
            queryClient.setQueryData(
              roomDetailKey(workspaceId, roomId),
              await rpc.workspaces.setRoomAgentJoinEvents({
                workspaceId,
                roomId,
                agentId,
                receivesJoinEvents: on,
              })
            );
          },
        },
      };
    }
  }

  const act = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(consoleChat ? chatFailure(cause).message : failureText(cause, fallback));
    }
  };

  return (
    <aside
      aria-label="Room"
      className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2"
    >
      <Fold
        title="Agents"
        count={agentIds.length}
        onAdd={controls.addAgents}
        addLabel={consoleChat ? 'Add participants' : 'Add agents'}
      >
        {unreadable ? (
          <Note>{failureText(detail.error, 'Could not read who is in this room.')}</Note>
        ) : agentIds.length === 0 ? (
          <Note>No agents in this room yet.</Note>
        ) : (
          agentIds.map((agentId) => (
            <AgentRow
              key={agentId}
              agentId={agentId}
              roomId={roomId}
              workspaceId={workspaceId}
              serverId={serverId}
              name={chatNames.get(agentId) ?? null}
              status={room?.agentStatuses[agentId]}
              roles={room?.roles ?? []}
              controls={controls}
              act={act}
            />
          ))
        )}
      </Fold>

      <Fold
        title={consoleChat ? 'People' : 'People seen here'}
        count={people.length}
        onAdd={controls.addPeople}
        addLabel="Add people"
      >
        {unreadable ? null : people.length === 0 ? (
          <Note>{consoleChat ? 'Nobody else is here yet.' : 'Nobody has been seen here yet.'}</Note>
        ) : (
          people.map((person) => (
            <PersonRow
              key={person.key}
              name={person.name}
              fullName={person.fullName}
              detail={person.detail}
              onRemove={controls.removePerson(person.key)}
              act={act}
            />
          ))
        )}
        {!consoleChat && (
          // Switch only knows the people who posted here or were added through it.
          <Note>
            People who posted here or were added through Switch. The channel may have more.
          </Note>
        )}
        {controls.peopleNote !== null && <Note>{controls.peopleNote}</Note>}
      </Fold>

      {error !== null && <p className="px-2 text-xs text-destructive">{error}</p>}

      <Dialog open={adding !== null} onOpenChange={(open) => !open && setAdding(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {adding === 'people' ? 'Add people' : consoleChat ? 'Add participants' : 'Add agents'}
            </DialogTitle>
          </DialogHeader>
          <DialogContentArea className="flex flex-col gap-3 pt-0">
            {adding === 'agents' && consoleChat && chat && serverId && (
              <ChatAddParticipantPanel
                serverId={serverId}
                workspaceId={workspaceId}
                chat={chat}
                memberIds={new Set(people.map((person) => person.key))}
                onAddedPeople={(next) => queryClient.setQueryData(membersKey, next)}
              />
            )}
            {adding === 'agents' && !consoleChat && room && workspaceId && (
              <>
                <AddAgentPanel workspaceId={workspaceId} room={room} onAdded={refreshRoom} />
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setAdding(null);
                    showAddAgentsToRoomModal({ roomId });
                  }}
                >
                  <FileText className="size-3.5" />
                  From a template
                </Button>
              </>
            )}
            {adding === 'people' && room && workspaceId && room.bridgeId !== null && (
              <AddPeoplePanel workspaceId={workspaceId} room={room} bridgeId={room.bridgeId} />
            )}
          </DialogContentArea>
        </DialogContent>
      </Dialog>
    </aside>
  );
});

/**
 * One agent in the room: its name, what it is doing here and the role it holds.
 * The viewer's own agents open their seat in this room on the agent's page;
 * anyone else's are listed only. Whoever may change the room gets a menu for
 * it here.
 */
const AgentRow = observer(function AgentRow({
  agentId,
  roomId,
  workspaceId,
  serverId,
  name,
  status,
  roles,
  controls,
  act,
}: {
  agentId: string;
  roomId: string;
  workspaceId: string | null;
  serverId: string | null;
  name: string | null;
  status: string | undefined;
  /** The room's roles; those this agent holds are shown beside its status. */
  roles: RemoteRoomDetail['roles'];
  controls: RosterControls;
  act: (action: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const { navigate } = useNavigate();
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((agent) => [agent.id, agent]));
  const managed = useManagedAgents(serverId);
  const own = (managed.data ?? []).find((agent) => agent.agentId === agentId) ?? null;
  const [busy, setBusy] = useState(false);
  const label = name ?? agentNameFor(agentId, workspaceId, remoteById);
  const held = rolesHeldBy(roles, remoteById.get(agentId)?.name ?? null);
  const presence = roomAgentPresence(status);
  const detail = [status === undefined ? null : presence.label, ...held]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <>
      <span className="relative flex shrink-0">
        <AgentMark agentId={agentId} workspaceId={workspaceId} remoteById={remoteById} />
        {status !== undefined && (
          <span
            aria-hidden
            className={cn(
              'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background',
              TONE_CLASS[presence.tone]
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">{label}</span>
        {detail && <span className="truncate text-xs text-foreground-muted">{detail}</span>}
      </span>
    </>
  );

  const run = (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    void act(action, fallback).finally(() => setBusy(false));
  };
  const { removeAgent, joinEvents } = controls;
  const menu =
    removeAgent || joinEvents ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${label} in this room`}
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            >
              {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {joinEvents && (
            <DropdownMenuCheckboxItem
              checked={joinEvents.listening(agentId)}
              onCheckedChange={(next) =>
                run(() => joinEvents.set(agentId, next), 'Could not change the join notification.')
              }
            >
              Tell it when someone joins
            </DropdownMenuCheckboxItem>
          )}
          {removeAgent && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => run(() => removeAgent(agentId), `Could not remove ${label}.`)}
            >
              Remove from room
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <div className="group flex items-center gap-1 rounded-md hover:bg-[var(--sel-soft)]">
      {own && serverId ? (
        <button
          type="button"
          title={`Open ${label}’s session in this room`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left"
          onClick={() =>
            navigate('managedAgent', { serverId, agentId, name: own.name, room: roomId })
          }
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">{body}</div>
      )}
      {menu}
    </div>
  );
});

function PersonRow({
  name,
  fullName,
  detail,
  onRemove,
  act,
}: {
  name: string;
  /** For a messaging-app username, the name of the Switch user who linked it, shown in brackets. */
  fullName: string | null;
  detail: string | null;
  onRemove: (() => Promise<void>) | null;
  act: (action: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--sel-soft)]">
      <PersonMark name={name} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {name}
        {fullName !== null && <span className="text-foreground-muted"> ({fullName})</span>}
      </span>
      {detail && <span className="shrink-0 text-xs text-foreground-muted">{detail}</span>}
      {onRemove && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${name} in this room`}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
              >
                {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setBusy(true);
                void act(onRemove, `Could not remove ${name}.`).finally(() => setBusy(false));
              }}
            >
              Remove from room
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Fold({
  title,
  count,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  count: number;
  onAdd: (() => void) | null;
  addLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="flex flex-col gap-[2px]">
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
        >
          <Chevron className="size-3.5" />
          <span className="flex-1 text-left">{title}</span>
          <span className="text-[var(--fg-passive)] tabular-nums">{count}</span>
        </button>
        {onAdd && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={addLabel}
            title={addLabel}
            onClick={onAdd}
          >
            <Plus />
          </Button>
        )}
      </div>
      {open && children}
    </section>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>
);

/**
 * The roles an agent holds. The server names a role's holders by the agent's
 * server-side name, so that is what is matched, never the name this install
 * shows (a local rename, or a chat's label); null holds nothing.
 */
export function rolesHeldBy(roles: RemoteRoomDetail['roles'], serverName: string | null): string[] {
  if (serverName === null) return [];
  return roles.filter((role) => role.heldBy.includes(serverName)).map((role) => role.name);
}

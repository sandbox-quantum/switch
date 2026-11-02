import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { chatMembersQueryKey } from '@renderer/features/chats/chat-people';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import { chatAgentLabel } from '@shared/core/chats/chats';
import { roomAgentPresence } from './room-agent-presence';
import { AgentMark, agentNameFor, PersonMark, roomDetailKey } from './room-configuration-panel';
import { roomTabStore } from './room-tab-store';

const TONE_CLASS = {
  live: 'bg-foreground-success',
  idle: 'bg-foreground-warning',
  off: 'bg-[var(--fg-passive)]',
} as const;

/**
 * The room's own column, beside its conversation: a way into its settings, and
 * what is in the room that the conversation does not already show — who the
 * agents are and what each is doing here, and who the people are.
 *
 * Nothing here is a setting. Settings live behind the button, on a page of their
 * own, so the column never repeats them; the room's name and description are in
 * the title bar above, so it does not repeat those either.
 */
export const RoomSidePanel = observer(function RoomSidePanel({ roomId }: { roomId: string }) {
  const chat = chatsStore.chat(roomId);
  const consoleChat = opensAsConsoleChat(roomId);
  const workspaceId =
    switchRoomsStore.roomWorkspaceId(roomId) ?? (chat ? workspacesStore.activeId : null);
  const serverId =
    switchRoomsStore.roomServerId(roomId) ?? (chat ? chatsStore.serverId : null) ?? null;
  // Anyone taking part may read the room, so this answers for a chat's members too.
  const detail = useQuery({
    queryKey: roomDetailKey(workspaceId ?? '', roomId),
    queryFn: () => rpc.workspaces.getRoomDetail({ workspaceId: workspaceId as string, roomId }),
    enabled: workspaceId !== null,
  });
  const members = useQuery({
    queryKey: chat && serverId ? chatMembersQueryKey(serverId, chat) : ['no-chat-members'],
    queryFn: () => rpc.chats.members(serverId as string, roomId),
    enabled: consoleChat && chat !== null && serverId !== null,
  });

  const room = detail.data ?? null;
  const agentIds = chat ? chat.agents.map((agent) => agent.id) : (room?.agentIds ?? []);
  const chatNames = new Map((chat?.agents ?? []).map((agent) => [agent.id, chatAgentLabel(agent)]));
  const people = consoleChat
    ? (members.data ?? []).map((member) => ({
        key: member.userId,
        name: member.name,
        detail: member.isOwner ? 'owner' : null,
      }))
    : (room?.connectedUserNames ?? []).map((name) => ({ key: name, name, detail: null }));

  return (
    <aside
      aria-label="Room"
      className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2"
    >
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-center"
        onClick={() => roomTabStore.setTab(roomId, 'configuration')}
      >
        <Settings className="size-3.5" />
        Room settings
      </Button>

      <Fold title="Agents" count={agentIds.length}>
        {agentIds.length === 0 ? (
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
            />
          ))
        )}
      </Fold>

      <Fold title={consoleChat ? 'People' : 'People seen here'} count={people.length}>
        {people.length === 0 ? (
          <Note>{consoleChat ? 'Nobody else is here yet.' : 'Nobody has been seen here yet.'}</Note>
        ) : (
          people.map((person) => (
            <div key={person.key} className="flex items-center gap-2 rounded-md px-2 py-1">
              <PersonMark name={person.name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {person.name}
              </span>
              {person.detail && (
                <span className="shrink-0 text-xs text-foreground-muted">{person.detail}</span>
              )}
            </div>
          ))
        )}
        {!consoleChat && (
          // Switch only knows the people who posted here or were added through it.
          <Note>
            People who posted here or were added through Switch. The channel may have more.
          </Note>
        )}
      </Fold>
    </aside>
  );
});

/**
 * One agent in the room: its name, what it is doing here and the role it holds.
 * The viewer's own agents open their seat in this room on the agent's page;
 * anyone else's are listed only.
 */
const AgentRow = observer(function AgentRow({
  agentId,
  roomId,
  workspaceId,
  serverId,
  name,
  status,
  roles,
}: {
  agentId: string;
  roomId: string;
  workspaceId: string | null;
  serverId: string | null;
  name: string | null;
  status: string | undefined;
  /** The room's roles; the one this agent holds is shown beside its status. */
  roles: { name: string; heldBy: string[] }[];
}) {
  const { navigate } = useNavigate();
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((agent) => [agent.id, agent]));
  const managed = useManagedAgents(serverId);
  const own = (managed.data ?? []).find((agent) => agent.agentId === agentId) ?? null;
  const label = name ?? agentNameFor(agentId, workspaceId, remoteById);
  // Roles name their holders by agent name, which is how the server reports them.
  const role = roles.find((each) => each.heldBy.includes(label));
  const presence = roomAgentPresence(status);
  const detail = [status === undefined ? null : presence.label, role?.name ?? null]
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

  if (own && serverId) {
    return (
      <button
        type="button"
        title={`Open ${label}’s session in this room`}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--sel-soft)]"
        onClick={() =>
          navigate('managedAgent', { serverId, agentId, name: own.name, room: roomId })
        }
      >
        {body}
      </button>
    );
  }
  return <div className="flex items-center gap-2 rounded-md px-2 py-1">{body}</div>;
});

function Fold({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="flex flex-col gap-[2px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1 pb-1 text-xs font-medium text-foreground-muted hover:text-foreground"
      >
        <Chevron className="size-3.5" />
        <span className="flex-1 text-left">{title}</span>
        <span className="text-[var(--fg-passive)] tabular-nums">{count}</span>
      </button>
      {open && children}
    </section>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>
);

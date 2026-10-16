import { ChevronDown, ChevronRight, Plus, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentConversations } from '@renderer/features/chats/agent-conversations';
import { ChatPanel } from '@renderer/features/chats/components/chat-panel';
import { ChatRow } from '@renderer/features/chats/components/chat-row';
import { directChats } from '@renderer/features/chats/start-direct-chat';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { RoomListRow } from '@renderer/features/sidebar/main-section';
import {
  SidebarItemMiniButton,
  SidebarMenuAction,
  SidebarMenuRow,
} from '@renderer/features/sidebar/sidebar-primitives';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { shouldAutoStartChat } from './auto-start-chat';
import { ManagedAgentPage } from './managed-agent-page';

export type AgentSection = 'settings';

const NAV_ITEMS = [
  { section: 'settings', label: 'Agent settings', icon: Settings },
] as const satisfies readonly { section: AgentSection; label: string; icon: typeof Settings }[];

function Section({
  title,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="flex flex-col gap-[2px] pb-3">
      <div className="flex items-center justify-between pr-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
        >
          <Chevron className="size-3.5" />
          {title}
        </button>
        <SidebarItemMiniButton aria-label={addLabel} title={addLabel} onClick={onAdd}>
          <Plus className="size-3.5" />
        </SidebarItemMiniButton>
      </div>
      {open && children}
    </section>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>
);

function conversationsOf({ serverId, workspaceId, agentId }: ManagedAgentView) {
  // The chats store follows the window's server; another server's chats are not in it.
  const agentChats = chatsStore.serverId === serverId ? chatsStore.chatsOfAgent(agentId) : [];
  const agentRooms = switchRoomsStore.roomsFor(workspaceId, agentId);
  return { agentRooms, ...agentConversations(agentChats, agentRooms ?? []) };
}

/** The direct chat open on an agent's page: the one in the params, else its newest. */
export function openAgentChat(
  agent: ManagedAgentView,
  roomId: string | undefined
): ChatSummary | null {
  const { direct } = conversationsOf(agent);
  return direct.find((chat) => chat.roomId === roomId) ?? direct[0] ?? null;
}

/**
 * An agent's page: its navigation (the agent's settings, its direct chats and
 * the rooms it is in, which open in the room view) beside what is selected.
 * The selection is kept in the view's params; with none chosen it is the
 * newest direct chat, and an agent with none gets one started once per visit.
 */
export const AgentChats = observer(function AgentChats({ agent }: { agent: ManagedAgentView }) {
  const { params, setParams } = useParams('managedAgent');
  const { serverId, workspaceId, agentId } = agent;
  useEffect(() => {
    void switchRoomsStore.fetchAgentRooms(workspaceId, agentId);
  }, [workspaceId, agentId]);

  const { agentRooms, direct, rooms } = conversationsOf(agent);
  const roomsError = switchRoomsStore.errorFor(workspaceId, agentId);
  const section = params.section;
  const roomId = openAgentChat(agent, params.roomId)?.roomId ?? null;
  const open = (id: string) => setParams({ roomId: id, section: undefined });
  const newChat = async () => {
    const chat = await directChats.start(serverId, agentId);
    if (chat) open(chat.roomId);
  };

  const ownServer = chatsStore.serverId === serverId;
  const listing = ownServer && chatsStore.userId === null && !chatsStore.listError;
  const autoStartTried = useRef(false);
  const [autoStarting, setAutoStarting] = useState(false);
  const autoStart = shouldAutoStartChat({
    listed: ownServer && chatsStore.userId !== null,
    listFailed: chatsStore.listError !== null,
    hasDirectChats: direct.length > 0,
    selected: Boolean(params.roomId) || section === 'settings',
    tried: autoStartTried.current,
  });
  useEffect(() => {
    if (!autoStart) return;
    autoStartTried.current = true;
    setAutoStarting(true);
    void newChat().finally(() => setAutoStarting(false));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the decision turns true, not when newChat is redefined
  }, [autoStart]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-border p-2">
        <nav aria-label="Agent" className="flex flex-col gap-[2px] pb-3">
          {NAV_ITEMS.map((item) => (
            <SidebarMenuRow
              key={item.section}
              isActive={section === item.section}
              onClick={() => setParams({ section: item.section })}
            >
              <div className="flex h-6 min-w-0 flex-1 items-center gap-1">
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <item.icon className="size-4 text-foreground-muted" />
                </span>
                <SidebarMenuAction className="overflow-hidden">
                  <span className="min-w-0 truncate">{item.label}</span>
                </SidebarMenuAction>
              </div>
            </SidebarMenuRow>
          ))}
        </nav>
        <Section title="Direct chats" addLabel="New chat" onAdd={() => void newChat()}>
          {chatsStore.listError && <Note>{chatsStore.listError}</Note>}
          {direct.map((chat) => (
            <ChatRow
              key={chat.roomId}
              serverId={serverId}
              chat={chat}
              isActive={!section && chat.roomId === roomId}
              onOpen={() => open(chat.roomId)}
            />
          ))}
          {direct.length === 0 && <Note>No direct chats yet.</Note>}
        </Section>
        <Section
          title="Rooms"
          addLabel="Create room"
          onAdd={() => showModal('createRoomModal', { serverId })}
        >
          {roomsError && <Note>{roomsError}</Note>}
          {rooms.map((room) => (
            <RoomListRow
              key={room.roomId}
              room={{
                name: switchRoomsStore.roomNameById(room.roomId) ?? room.roomName,
                bridgeType: switchRoomsStore.roomBridgeTypeById(room.roomId),
                bridgeDisplayName:
                  switchRoomsStore.roomSummaryById(room.roomId)?.bridgeDisplayName ?? null,
              }}
              isActive={false}
              onOpen={() => openRoomView(room.roomId)}
            />
          ))}
          {!agentRooms && !roomsError && <Note>Loading…</Note>}
          {agentRooms && rooms.length === 0 && <Note>Not in any room yet.</Note>}
        </Section>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {section === 'settings' ? (
          <ManagedAgentPage agent={agent} />
        ) : roomId ? (
          <>
            <ChatPanel key={`${serverId}:${roomId}`} serverId={serverId} roomId={roomId} />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent"
            />
          </>
        ) : listing || autoStart || autoStarting ? null : (
          <EmptyState
            label="No chat open"
            description="Start a chat with this agent."
            action={<Button onClick={() => void newChat()}>Start a chat</Button>}
          />
        )}
      </div>
    </div>
  );
});

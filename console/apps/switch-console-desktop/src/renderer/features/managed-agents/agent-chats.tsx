import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentConversations } from '@renderer/features/chats/agent-conversations';
import { ArchivedFold } from '@renderer/features/chats/components/archived-fold';
import { ChatPanel } from '@renderer/features/chats/components/chat-panel';
import { ChatRow, UnsavedChatRow } from '@renderer/features/chats/components/chat-row';
import { useOpenGroupAsRoom } from '@renderer/features/chats/console-chat-redirect';
import { directChats } from '@renderer/features/chats/start-direct-chat';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { RoomListRow } from '@renderer/features/sidebar/main-section';
import { SidebarItemMiniButton } from '@renderer/features/sidebar/sidebar-primitives';
import { EmbeddedRoom } from '@renderer/features/switch-rooms/view';
import { isConsoleDirectChatSummary } from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import type { ChatSummary } from '@shared/core/chats/chats';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { AgentConnectionsTab, useAgentServiceGrants } from './agent-connections-tab';
import { AgentProfile, managedAgentMachineLine } from './agent-profile';
import {
  type AgentSection,
  agentSections,
  shownAgentRoom,
  shownAgentSection,
} from './agent-sections';
import { shouldAutoStartChat } from './auto-start-chat';
import { ManagedAgentPage } from './managed-agent-page';
import { managedAgentLabel } from './managed-agent-state';
import { useRunsOnThisComputer } from './use-managed-agents';

/**
 * The sections the agent's page offers, and the one showing: `chosen` from
 * the view's params when it is offered, else none, and a chat shows.
 */
export function useAgentSection(
  serverId: string,
  agent: ManagedAgentView | null,
  chosen: AgentSection | undefined
) {
  const flags = useFeatureFlags(serverId);
  const grants = useAgentServiceGrants(
    flags.service_connections,
    agent?.workspaceId ?? null,
    agent?.agentId ?? ''
  );
  const sections = agentSections(flags.service_connections, grants.data);
  return { sections, section: shownAgentSection(chosen, sections) };
}

function Section({
  title,
  addLabel,
  onAdd,
  addChoices,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  /** Ways to add, offered as a menu on the button instead of `onAdd`; null for just `onAdd`. */
  addChoices: { label: string; onSelect: () => void }[] | null;
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
        {addChoices ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarItemMiniButton aria-label={addLabel} title={addLabel}>
                  <Plus className="size-3.5" />
                </SidebarItemMiniButton>
              }
            />
            <DropdownMenuContent align="end">
              {addChoices.map((choice) => (
                <DropdownMenuItem key={choice.label} onClick={choice.onSelect}>
                  {choice.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <SidebarItemMiniButton aria-label={addLabel} title={addLabel} onClick={onAdd}>
            <Plus className="size-3.5" />
          </SidebarItemMiniButton>
        )}
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
  const ownServer = chatsStore.serverId === serverId;
  const agentChats = ownServer ? chatsStore.chatsOfAgent(agentId) : [];
  const archived = ownServer
    ? chatsStore.archivedOfAgent(agentId).filter(isConsoleDirectChatSummary)
    : [];
  const agentRooms = switchRoomsStore.roomsFor(workspaceId, agentId);
  return {
    agentRooms,
    archived,
    ...agentConversations(agentChats, agentRooms ?? [], chatsStore.removed),
  };
}

/** Whether `roomId` is the agent's unsaved chat, open now or kept from before a reload. */
function isUnsavedChatOf(agent: ManagedAgentView, roomId: string): boolean {
  return (
    directChats.unsavedChat(roomId) !== undefined ||
    directChats.waiting(agent.serverId, agent.agentId) === roomId
  );
}

/**
 * The direct chat open on an agent's page: the one in the params, archived or
 * not, else its newest; none while the open chat is unsaved, so nothing of
 * another chat stands in for it.
 */
export function openAgentChat(
  agent: ManagedAgentView,
  roomId: string | undefined
): ChatSummary | null {
  if (roomId && isUnsavedChatOf(agent, roomId)) return null;
  const { direct, archived } = conversationsOf(agent);
  return [...direct, ...archived].find((chat) => chat.roomId === roomId) ?? direct[0] ?? null;
}

/** The room shown on an agent's page in place of a chat, if one is. */
export function openAgentRoom(
  agent: ManagedAgentView,
  room: string | undefined,
  section: AgentSection | null
): string | null {
  const { agentRooms, rooms } = conversationsOf(agent);
  return shownAgentRoom(room, section, agentRooms && rooms);
}

/**
 * An agent's page: its profile (with buttons to its own sections), its direct
 * chats and the rooms it is in, each opened in place beside the column.
 * The selection is kept in the view's params; with none chosen it is the
 * newest direct chat, and an agent with none gets one started once per visit.
 */
export const AgentChats = observer(function AgentChats({ agent }: { agent: ManagedAgentView }) {
  const { params, setParams } = useParams('managedAgent');
  const { serverId, workspaceId, agentId } = agent;
  useEffect(() => {
    return switchRoomsStore.watchMembership(workspaceId, agentId);
  }, [workspaceId, agentId]);

  const { agentRooms, direct, archived, rooms } = conversationsOf(agent);
  const roomsError = switchRoomsStore.errorFor(workspaceId, agentId);
  const { sections, section } = useAgentSection(serverId, agent, params.section);
  const thisComputer = useRunsOnThisComputer(agent);
  const shownRoom = openAgentRoom(agent, params.room, section);
  // The unsaved chat open before a reload is kept, but not in memory yet: it opens again.
  const restoring =
    !!params.roomId &&
    !directChats.unsavedChat(params.roomId) &&
    isUnsavedChatOf(agent, params.roomId);
  const roomId =
    shownRoom || restoring
      ? null
      : params.roomId && directChats.unsavedChat(params.roomId)
        ? params.roomId
        : (openAgentChat(agent, params.roomId)?.roomId ?? null);
  const open = (id: string) => setParams({ roomId: id, section: undefined, room: undefined });
  useEffect(() => {
    if (restoring) setParams({ roomId: directChats.start(serverId, agentId) });
  }, [restoring, serverId, agentId, setParams]);
  // The chat open here that becomes a group follows into its room, rather than another chat taking its place.
  useOpenGroupAsRoom(shownRoom || section ? null : (params.roomId ?? null), 'managedAgent');
  const newChat = () => open(directChats.start(serverId, agentId));
  const unsavedId = directChats.waiting(serverId, agentId);

  const ownServer = chatsStore.serverId === serverId;
  const listing = ownServer && chatsStore.userId === null && !chatsStore.listError;
  const autoStartTried = useRef(false);
  const autoStart = shouldAutoStartChat({
    listed: ownServer && chatsStore.userId !== null,
    listFailed: chatsStore.listError !== null,
    hasDirectChats: direct.length > 0,
    selected: Boolean(params.roomId) || section !== null || shownRoom !== null,
    tried: autoStartTried.current,
  });
  useEffect(() => {
    if (!autoStart) return;
    autoStartTried.current = true;
    newChat();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the decision turns true, not when newChat is redefined
  }, [autoStart]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-border p-2">
        <AgentProfile
          name={managedAgentLabel(agent)}
          iconUrl={agent.iconUrl}
          serverId={serverId}
          machine={managedAgentMachineLine(agent, thisComputer)}
          sections={sections}
          selected={section}
          onSelect={(chosen) => setParams({ section: chosen })}
        />
        <Section title="Direct chats" addLabel="New chat" onAdd={newChat} addChoices={null}>
          {ownServer && chatsStore.listError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-foreground-muted"
            >
              <span>{chatsStore.listError}</span>
              <Button size="sm" variant="outline" onClick={() => void chatsStore.connect(serverId)}>
                Try again
              </Button>
            </div>
          )}
          {unsavedId && (
            <UnsavedChatRow isActive={!section && unsavedId === roomId} onOpen={newChat} />
          )}
          {direct.map((chat) => (
            <ChatRow
              key={chat.roomId}
              serverId={serverId}
              chat={chat}
              isActive={!section && chat.roomId === roomId}
              onOpen={() => open(chat.roomId)}
            />
          ))}
          {direct.length === 0 && !unsavedId && !chatsStore.listError && (
            <Note>No direct chats yet.</Note>
          )}
          <ArchivedFold count={archived.length} error={ownServer ? chatsStore.archivedError : null}>
            {archived.map((chat) => (
              <ChatRow
                key={chat.roomId}
                serverId={serverId}
                chat={chat}
                isActive={!section && chat.roomId === roomId}
                onOpen={() => open(chat.roomId)}
              />
            ))}
          </ArchivedFold>
        </Section>
        <Section
          title="Rooms"
          addLabel="Add to a room"
          onAdd={() => showModal('createRoomModal', { serverId, agentId })}
          addChoices={[
            {
              label: 'New room',
              onSelect: () => showModal('createRoomModal', { serverId, agentId }),
            },
            {
              label: 'Add to existing room',
              onSelect: () =>
                showModal('addAgentToRoomModal', {
                  workspaceId,
                  switchAgentId: agentId,
                  agentName: managedAgentLabel(agent),
                }),
            },
          ]}
        >
          {roomsError && <Note>{roomsError}</Note>}
          {rooms.map((room) => (
            <RoomListRow
              key={room.roomId}
              roomId={room.roomId}
              room={{
                name: switchRoomsStore.roomNameById(room.roomId) ?? room.roomName,
                bridgeType: switchRoomsStore.roomBridgeTypeById(room.roomId),
                bridgeDisplayName:
                  switchRoomsStore.roomSummaryById(room.roomId)?.bridgeDisplayName ?? null,
              }}
              isActive={room.roomId === shownRoom}
              onOpen={() => setParams({ room: room.roomId, section: undefined })}
            />
          ))}
          {!agentRooms && !roomsError && <Note>Loading…</Note>}
          {agentRooms && rooms.length === 0 && <Note>Not in any room yet.</Note>}
        </Section>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {section === 'settings' ? (
          <ManagedAgentPage agent={agent} serviceGrants={!sections.includes('connections')} />
        ) : section === 'connections' ? (
          <AgentConnectionsTab
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            agentName={managedAgentLabel(agent)}
            cloud={agent.machine !== null && isCloudMachine(agent.machine)}
          />
        ) : shownRoom ? (
          <EmbeddedRoom roomId={shownRoom} />
        ) : roomId ? (
          <>
            <ChatPanel key={`${serverId}:${roomId}`} serverId={serverId} roomId={roomId} />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b from-background to-transparent"
            />
          </>
        ) : listing || autoStart || restoring ? null : (
          <EmptyState
            label="No chat open"
            description="Start a chat with this agent."
            action={<Button onClick={newChat}>Start a chat</Button>}
          />
        )}
      </div>
    </div>
  );
});

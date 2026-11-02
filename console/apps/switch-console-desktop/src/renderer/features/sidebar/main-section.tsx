import { Archive, ArchiveRestore, DoorOpen, MessageCircle, MoreHorizontal, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ArchivedFold } from '@renderer/features/chats/components/archived-fold';
import { UnreadBadge } from '@renderer/features/chats/components/unread-badge';
import { ManagedAgentList } from '@renderer/features/managed-agents/managed-agent-list';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { BuddyAvatar } from '@renderer/features/switch-buddy/buddy-avatar';
import { expectedBuddyName } from '@renderer/features/switch-buddy/buddy-identity';
import { useBuddyPending } from '@renderer/features/switch-buddy/buddy-pending';
import { buddyPerson } from '@renderer/features/switch-buddy/buddy-person';
import { roomArchiveAction } from '@renderer/features/switch-rooms/room-archive';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useListedRoomsInActiveScope } from '@renderer/features/switch-servers/use-listed-rooms';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useCurrentViewId } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { NewRoomRow } from './new-room-row';
import { SidebarMenuRow } from './sidebar-primitives';
import { isRoomViewActive, openRoomView } from './sidebar-room-grouping';

type MainTab = 'agents' | 'rooms';

const TAB_KEY = 'sidebar.mainTab';
const CHATS_TEASER_KEY = 'sidebar.chatsTeaserDismissed';

const TABS: { value: MainTab; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'rooms', label: 'Rooms' },
];

function storedTab(): MainTab {
  return localStorage.getItem(TAB_KEY) === 'rooms' ? 'rooms' : 'agents';
}

/**
 * The sidebar's main section on a server that runs agent management: its
 * managed agents or its rooms, one row each, behind an Agents / Rooms switch.
 *
 * Shown only once the server has a managed agent. Until then everything is
 * still under the legacy Sessions section, and a switch over an empty list
 * would be the first thing on screen with nothing behind it.
 */
export const SidebarMainSection = observer(function SidebarMainSection() {
  const [tab, setTab] = useState<MainTab>(storedTab);
  const agents = useManagedAgents(switchServersStore.activeServerId);
  const flags = useFeatureFlags(switchServersStore.activeServerId);
  const buddyPending = useBuddyPending(switchServersStore.activeServerId);
  const rooms = useListedRoomsInActiveScope();
  // No count until the agents are read: a 0 that turns into the real number
  // a moment later reads as the list changing.
  const count =
    tab === 'agents'
      ? (agents.data?.length ?? null)
      : rooms.filter((room) => !room.archivedByViewer).length;

  return (
    <section aria-label={tab === 'agents' ? 'Agents' : 'Rooms'} className="flex flex-col">
      <div className="flex items-center justify-between px-[9px] pt-4 pb-1.5">
        <SegmentedControl
          value={tab}
          onChange={(next) => {
            setTab(next);
            localStorage.setItem(TAB_KEY, next);
          }}
          options={TABS}
          ariaLabel="Show agents or rooms"
          quiet
        />
        <span className="text-[11.5px] text-[var(--fg-passive)] tabular-nums">{count}</span>
      </div>
      {tab === 'agents' ? (
        <>
          {buddyPending && switchServersStore.activeServerId !== null && (
            <PendingBuddyRow serverId={switchServersStore.activeServerId} />
          )}
          <ManagedAgentList />
          {agents.data?.length === 0 && !BUILD_FEATURE_FLAGS.onboarding && (
            <p className="px-[9px] py-2 text-xs text-foreground-muted">No agents yet.</p>
          )}
          {!flags.agent_chats && <ChatsTeaser />}
        </>
      ) : (
        <RoomList rooms={rooms} />
      )}
    </section>
  );
});

/**
 * switch-buddy before it exists — skipped in onboarding, or never set up —
 * so its chat, and the way to give it a provider, can always be found.
 */
const PendingBuddyRow = observer(function PendingBuddyRow({ serverId }: { serverId: string }) {
  const active = useCurrentViewId() === 'switchBuddy';
  const name = expectedBuddyName(buddyPerson(serverId));
  return (
    <SidebarMenuRow
      isActive={active}
      title={`${name} — connect an AI provider to start it`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => appState.navigation.navigate('switchBuddy', { serverId })}
      className="h-[32px] py-0 text-[13.5px]"
    >
      <BuddyAvatar size={20} shape="round" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </SidebarMenuRow>
  );
});

/**
 * New Room, then one row per room: its messaging app and its name. Nothing is
 * nested under it. The rooms this person archived are folded away at the end.
 */
const RoomList = observer(function RoomList({ rooms }: { rooms: RemoteRoomSummary[] }) {
  const showCreateRoomModal = useShowModal('createRoomModal');
  const active = rooms.filter((room) => !room.archivedByViewer);
  const archived = rooms.filter((room) => room.archivedByViewer);
  const row = (room: RemoteRoomSummary) => (
    <RoomListRow
      key={room.id}
      roomId={room.id}
      room={room}
      isActive={isRoomViewActive(room.id)}
      onOpen={() => openRoomView(room.id)}
    />
  );
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Rooms">
      <NewRoomRow onCreate={() => showCreateRoomModal({})} />
      {rooms.length === 0 && (
        <p className="px-[9px] py-2 text-xs text-foreground-muted">No rooms on this server.</p>
      )}
      {active.map(row)}
      <ArchivedFold count={archived.length} error={null}>
        {archived.map(row)}
      </ArchivedFold>
    </div>
  );
});

/** One room's row, with its Archive or Unarchive behind a ⋯ button and a right-click. */
export const RoomListRow = observer(function RoomListRow({
  roomId,
  room,
  isActive,
  onOpen,
}: {
  roomId: string;
  room: Pick<RemoteRoomSummary, 'name' | 'bridgeType' | 'bridgeDisplayName'>;
  isActive: boolean;
  onOpen: () => void;
}) {
  const archive = roomArchiveAction(roomId);
  const icon =
    archive?.label === 'Unarchive' ? (
      <ArchiveRestore className="size-4" />
    ) : (
      <Archive className="size-4" />
    );
  const row = (
    <SidebarMenuRow
      isActive={isActive}
      title={room.bridgeDisplayName ? `${room.name} · ${room.bridgeDisplayName}` : room.name}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="group/row h-[30px] py-0 text-[13px]"
    >
      {hasBridgeIcon(room.bridgeType) ? (
        <BridgeIcon bridgeType={room.bridgeType} size={17} className="shrink-0" />
      ) : (
        <DoorOpen className="size-[17px] shrink-0 text-[var(--fg-icon)]" />
      )}
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
      <UnreadBadge roomId={roomId} />
      {archive && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-tertiary-muted opacity-0 group-hover/row:opacity-100 hover:bg-background-tertiary-2 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            aria-label={`Actions for ${room.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={archive.run}>
              {icon}
              {archive.label}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarMenuRow>
  );
  if (!archive) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <ContextMenuItem onClick={archive.run}>
          {icon}
          {archive.label}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * One sentence about what is coming for these agents, under them, closed for
 * good with its ×.
 */
function ChatsTeaser() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(CHATS_TEASER_KEY) === '1');
  if (dismissed) return null;
  return (
    <div className="mx-[2px] mt-3 flex gap-2.5 rounded-[10px] border-[0.5px] border-[var(--hair)] bg-[var(--menu-faint)] p-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-[rgb(79_160_94_/_0.14)] text-[#8fcb9e]">
        <MessageCircle className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-[var(--fg-name)]">
          Chats with agents are coming
        </p>
        <p className="mt-0.5 text-xs leading-snug text-[var(--fg-dim)]">
          Soon you&rsquo;ll talk to any of these agents directly, not only in rooms.
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--fg-icon)] hover:bg-[var(--sel-soft)] hover:text-foreground"
        onClick={() => {
          localStorage.setItem(CHATS_TEASER_KEY, '1');
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

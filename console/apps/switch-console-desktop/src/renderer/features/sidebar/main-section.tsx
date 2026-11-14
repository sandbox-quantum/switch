import { RoomRow } from '@switch-console/chat-ui/components/chat-row';
import { NewRoomRow } from '@switch-console/chat-ui/components/new-room-row';
import { RoomAppChips } from '@switch-console/chat-ui/components/room-app-chips';
import { appsOf, inApp } from '@switch-console/chat-ui/model/room-apps';
import {
  byActivity,
  holdingOpenRoom,
  roomActivityAt,
} from '@switch-console/chat-ui/model/room-order';
import { MessageCircle, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef, useState } from 'react';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { ManagedAgentList } from '@renderer/features/managed-agents/managed-agent-list';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { BuddyAvatar } from '@renderer/features/switch-buddy/buddy-avatar';
import { expectedBuddyName } from '@renderer/features/switch-buddy/buddy-identity';
import { useBuddyPending } from '@renderer/features/switch-buddy/buddy-pending';
import { buddyPerson } from '@renderer/features/switch-buddy/buddy-person';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useListedRoomsInActiveScope } from '@renderer/features/switch-servers/use-listed-rooms';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useCurrentViewId } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { SidebarMenuRow } from './sidebar-primitives';
import { isRoomViewActive, openRoomView } from './sidebar-room-grouping';

type MainTab = 'agents' | 'rooms';

const TAB_KEY = 'sidebar.mainTab';
const ROOM_APP_KEY = 'sidebar.roomApp';
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
  // While the agents are showing, a dot on Rooms says a room has something new.
  const roomsUnread = rooms.some((room) => chatsStore.unread(room.id) > 0);
  // No count until the agents are read: a 0 that turns into the real number
  // a moment later reads as the list changing.
  const count = tab === 'agents' ? (agents.data?.length ?? null) : rooms.length;

  return (
    <section aria-label={tab === 'agents' ? 'Agents' : 'Rooms'} className="flex flex-col">
      <div className="flex items-center justify-between px-[9px] pt-4 pb-1.5">
        <SegmentedControl
          value={tab}
          onChange={(next) => {
            setTab(next);
            localStorage.setItem(TAB_KEY, next);
          }}
          options={TABS.map((option) =>
            option.value === 'rooms' && roomsUnread && tab !== 'rooms'
              ? { ...option, dot: true }
              : option
          )}
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

/** The sidebar's rooms: unread first, then the most recently active (see `byActivity`). */
function sidebarOrder(rooms: RemoteRoomSummary[]): RemoteRoomSummary[] {
  return byActivity(rooms, (room) => ({
    name: room.name,
    activityAt: roomActivityAt(chatsStore.chat(room.id), room),
    unread: chatsStore.unread(room.id) > 0,
  }));
}

/**
 * Where the open room sat in the list on screen when it was opened, kept while
 * it stays open; null when none is open or it was not on screen. `remember`
 * takes the order shown, for the next room opened.
 */
function useHeldPlace(openId: string | null): {
  place: number | null;
  remember: (shown: string[]) => void;
} {
  const held = useRef<{ id: string | null; place: number | null; shown: string[] }>({
    id: null,
    place: null,
    shown: [],
  });
  if (held.current.id !== openId) {
    // From the order on screen when it was clicked, not the one the click makes.
    const place = openId === null ? -1 : held.current.shown.indexOf(openId);
    held.current = { ...held.current, id: openId, place: place >= 0 ? place : null };
  }
  return {
    place: held.current.place,
    remember: (shown) => {
      held.current.shown = shown;
    },
  };
}

/**
 * New Room, then one row per room: its messaging app and its name, the rooms
 * with something new first. Nothing is nested under it.
 */
const RoomList = observer(function RoomList({ rooms: listed }: { rooms: RemoteRoomSummary[] }) {
  const showCreateRoomModal = useShowModal('createRoomModal');
  const [app, setApp] = useState<string | null>(() => localStorage.getItem(ROOM_APP_KEY));
  const apps = appsOf(listed);
  const chosen = app !== null && apps.includes(app) ? app : null;
  const ordered = sidebarOrder(inApp(listed, chosen));
  const openId = ordered.find((room) => isRoomViewActive(room.id))?.id ?? null;
  const { place, remember } = useHeldPlace(openId);
  const rooms = holdingOpenRoom(ordered, openId, place);
  remember(rooms.map((room) => room.id));
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Rooms">
      <NewRoomRow onCreate={() => showCreateRoomModal({})} />
      <RoomAppChips
        apps={apps}
        selected={chosen}
        onSelect={(next) => {
          setApp(next);
          if (next === null) localStorage.removeItem(ROOM_APP_KEY);
          else localStorage.setItem(ROOM_APP_KEY, next);
        }}
      />
      {rooms.length === 0 && (
        <p className="px-[9px] py-2 text-xs text-foreground-muted">No rooms on this server.</p>
      )}
      {rooms.map((room) => (
        <RoomRow
          key={room.id}
          roomId={room.id}
          room={room}
          isActive={isRoomViewActive(room.id)}
          onOpen={() => openRoomView(room.id)}
        />
      ))}
    </div>
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

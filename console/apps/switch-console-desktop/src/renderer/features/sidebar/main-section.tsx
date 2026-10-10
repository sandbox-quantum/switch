import { DoorOpen, MessageCircle, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ManagedAgentList } from '@renderer/features/managed-agents/managed-agent-list';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
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
  const rooms = switchRoomsStore.listedRoomsInActiveScope;
  const count = tab === 'agents' ? (agents.data?.length ?? 0) : rooms.length;

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
          <ManagedAgentList />
          {agents.data?.length === 0 && (
            <p className="px-[9px] py-2 text-xs text-foreground-muted">No agents yet.</p>
          )}
          <ChatsTeaser />
        </>
      ) : (
        <RoomList rooms={rooms} />
      )}
    </section>
  );
});

/** One row per room: its messaging app and its name. Nothing is nested under it. */
const RoomList = observer(function RoomList({ rooms }: { rooms: RemoteRoomSummary[] }) {
  if (rooms.length === 0) {
    return <p className="px-[9px] py-2 text-xs text-foreground-muted">No rooms on this server.</p>;
  }
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Rooms">
      {rooms.map((room) => (
        <SidebarMenuRow
          key={room.id}
          isActive={isRoomViewActive(room.id)}
          title={room.bridgeDisplayName ? `${room.name} · ${room.bridgeDisplayName}` : room.name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openRoomView(room.id)}
          className="h-[30px] py-0 text-[13px]"
        >
          {hasBridgeIcon(room.bridgeType) ? (
            <BridgeIcon bridgeType={room.bridgeType} size={17} className="shrink-0" />
          ) : (
            <DoorOpen className="size-[17px] shrink-0 text-[var(--fg-icon)]" />
          )}
          <span className="min-w-0 flex-1 truncate">{room.name}</span>
        </SidebarMenuRow>
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

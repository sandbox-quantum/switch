import { ChevronRight, DoorOpen, ExternalLink } from 'lucide-react';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { SidebarItemMiniButton, SidebarMenuRow } from './sidebar-primitives';
import { depthIndent, UNASSIGNED_ROOM_KEY } from './sidebar-store';

/** Current room of a session, from the live connection set reported by the hook. */
export function sessionRoomId(session: SessionStore): string | null {
  return roomConnectionsStore.roomForSession(session.data.id);
}

export function roomLabel(roomKey: string): string {
  if (roomKey === UNASSIGNED_ROOM_KEY) return 'Unassigned';
  return switchRoomsStore.roomNameById(roomKey) ?? `Room ${roomKey.slice(0, 8)}`;
}

/** Open a room's detail page in the gateway web app (no-op for Unassigned). */
export function openRoomInGateway(roomKey: string): void {
  if (roomKey === UNASSIGNED_ROOM_KEY) return;
  const url = switchRoomsStore.gatewayRoomUrl(roomKey);
  if (url) void rpc.app.openExternal(url);
}

/**
 * Open a room's bridged channel in the messaging app's desktop client (Slack,
 * Mattermost) via the native deeplink the gateway built. No-op when the room
 * isn't bridged or the link is unknown.
 */
export function openRoomInMessagingApp(roomKey: string): void {
  if (roomKey === UNASSIGNED_ROOM_KEY) return;
  const url = switchRoomsStore.roomChannelUrl(roomKey);
  if (url) void rpc.app.openExternal(url);
}

/** Group sessions by their current room key, named rooms first then Unassigned. */
export function groupByRoom(sessions: SessionStore[]): [string, SessionStore[]][] {
  const groups = new Map<string, SessionStore[]>();
  for (const session of sessions) {
    const key = sessionRoomId(session) ?? UNASSIGNED_ROOM_KEY;
    const list = groups.get(key);
    if (list) list.push(session);
    else groups.set(key, [session]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNASSIGNED_ROOM_KEY) return 1;
    if (b === UNASSIGNED_ROOM_KEY) return -1;
    return roomLabel(a).localeCompare(roomLabel(b));
  });
}

/**
 * A room header row. The leading icon doubles as the expand toggle — it shows
 * the bridged platform's logo (Slack, Mattermost, …) for bridged rooms, else a
 * generic door icon, and swaps to a chevron on hover (rotated when expanded).
 * Clicking the row body toggles expand/collapse; opening the room in the gateway
 * web app is scoped to the dedicated "go to" button (named rooms only).
 */
export function RoomRow({
  label,
  count,
  expanded,
  onToggle,
  onOpenGateway,
  onOpenChannel = null,
  depth = 0,
  bridgeType = null,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenGateway: () => void;
  /** Open the room's channel in the messaging app, or null when there is no
   * native deeplink (room not bridged / link unknown). */
  onOpenChannel?: (() => void) | null;
  depth?: number;
  /** Bridge platform type (`slack`, `mattermost`, …) when the room is bridged. */
  bridgeType?: string | null;
}) {
  const linkable = label !== 'Unassigned';
  const channelLinkable = onOpenChannel !== null && hasBridgeIcon(bridgeType);
  return (
    <SidebarMenuRow
      className="group/room flex h-8 items-center gap-1 px-1"
      style={depthIndent(depth)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <SidebarItemMiniButton
        type="button"
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        className="relative"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {hasBridgeIcon(bridgeType) ? (
          <BridgeIcon
            bridgeType={bridgeType}
            size={16}
            className="absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/room:opacity-0"
          />
        ) : (
          <DoorOpen className="absolute h-4 w-4 text-foreground-muted opacity-100 transition-opacity duration-150 group-hover/room:opacity-0" />
        )}
        <ChevronRight
          className={cn(
            'absolute h-4 w-4 opacity-0 transition-all duration-150 group-hover/room:opacity-100',
            expanded && 'rotate-90'
          )}
        />
      </SidebarItemMiniButton>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {channelLinkable && (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarItemMiniButton
                type="button"
                aria-label={`Open ${label} in ${bridgeType}`}
                className="opacity-0 transition-opacity duration-150 group-hover/room:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChannel?.();
                }}
              >
                <BridgeIcon bridgeType={bridgeType} size={14} className="h-3.5 w-3.5" />
              </SidebarItemMiniButton>
            }
          />
          <TooltipContent>Open in {bridgeType}</TooltipContent>
        </Tooltip>
      )}
      {linkable && (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarItemMiniButton
                type="button"
                aria-label={`Open ${label} in gateway`}
                className="opacity-0 transition-opacity duration-150 group-hover/room:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenGateway();
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </SidebarItemMiniButton>
            }
          />
          <TooltipContent>Open in gateway</TooltipContent>
        </Tooltip>
      )}
      <span className="shrink-0 text-xs text-foreground-tertiary-passive">{count}</span>
    </SidebarMenuRow>
  );
}

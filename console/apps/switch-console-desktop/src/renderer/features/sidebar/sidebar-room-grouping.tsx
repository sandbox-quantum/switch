import { ChevronRight, DoorOpen, MoreVertical, Plus, Trash2 } from 'lucide-react';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { openRoomChannel } from '@renderer/features/switch-rooms/room-links';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { appState } from '@renderer/lib/stores/app-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
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

/**
 * Whether a room's label is its real name or a stand-in.
 *
 * A room's id reaches the sidebar by live push while its name needs the
 * server's room list, so the two can be out of step — most often when the
 * server is not connected, or its list failed to load. The short-id fallback
 * that results looks exactly like a name, which is what makes it a lie; rows
 * use this to mark it as not-yet-known instead.
 */
export function isRoomNameKnown(roomKey: string): boolean {
  if (roomKey === UNASSIGNED_ROOM_KEY) return true;
  return switchRoomsStore.roomNameById(roomKey) !== null;
}

/**
 * What a room row needs to offer deletion, or null when it must not offer it —
 * because the row is the Unassigned bucket, because the room's server or
 * summary has not loaded, or because this user is neither its owner nor an
 * admin.
 *
 * Returning the target rather than a boolean keeps the confirmation's arguments
 * and the decision to show it in one place; a row cannot end up with the button
 * and no idea what it would delete.
 */
export function deleteRoomAction(
  roomKey: string,
  showDeleteRoomModal: (args: { serverId: string; roomId: string; roomName: string }) => void
): (() => void) | null {
  if (roomKey === UNASSIGNED_ROOM_KEY) return null;
  const serverId = switchRoomsStore.roomServerId(roomKey);
  const room = switchRoomsStore.roomSummaryById(roomKey);
  if (!serverId || !room) return null;
  if (!switchRoomsStore.canDeleteRoom(serverId, room)) return null;
  return () => showDeleteRoomModal({ serverId, roomId: roomKey, roomName: room.name });
}

/** Show a room's conversation in the main panel (no-op for Unassigned, which
 * is a bucket rather than a real room). */
export function openRoomView(roomKey: string): void {
  if (roomKey === UNASSIGNED_ROOM_KEY) return;
  appState.navigation.navigate('room', { roomId: roomKey });
}

/**
 * Whether a room row is the one currently open in the main panel, so it can
 * carry the same selected styling as an agent or session row.
 *
 * Read from the navigation store rather than the `useParams` hook because the
 * room rows are produced inside `.map()` callbacks, where a hook cannot be
 * called. Observers re-render on navigation either way.
 */
export function isRoomViewActive(roomKey: string): boolean {
  if (roomKey === UNASSIGNED_ROOM_KEY) return false;
  if (appState.navigation.currentViewId !== 'room') return false;
  const params = appState.navigation.viewParamsStore.room;
  return (params as { roomId?: string } | undefined)?.roomId === roomKey;
}

/**
 * Open a room's bridged channel in the messaging app's desktop client (Slack,
 * Mattermost) via the native deeplink the gateway built. No-op when the room
 * isn't bridged or the link is unknown.
 */
export function openRoomInMessagingApp(roomKey: string): void {
  if (roomKey === UNASSIGNED_ROOM_KEY) return;
  openRoomChannel(roomKey);
}

/**
 * Group sessions by their current room key, named rooms first then Unassigned.
 *
 * `alwaysShow` room keys are included even with no sessions, so a room can be
 * listed before anything has connected to it — otherwise a room you just
 * created would be invisible until an agent joined it.
 */
export function groupByRoom(
  sessions: SessionStore[],
  alwaysShow: string[] = []
): [string, SessionStore[]][] {
  const groups = new Map<string, SessionStore[]>();
  for (const key of alwaysShow) groups.set(key, []);
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
 * A room header row. It leads with the bridged platform's logo (Slack,
 * Mattermost, …), or a generic door icon when the room is not bridged.
 *
 * Clicking the row opens the room; expanding and collapsing it belongs to the
 * chevron at the far end and to nothing else, so reading a room never rearranges
 * the tree underneath it. A row with no room behind it (Unassigned) has nothing
 * to open and so is not clickable at all.
 *
 * Everything else a room can do sits behind one menu rather than a strip of
 * icon buttons. A row that grows a button per capability spends the width it
 * needs for the room's name on affordances most people never press.
 */
export function RoomRow({
  label,
  hasChildren,
  expanded,
  onToggle,
  onOpenChannel = null,
  onSelect = null,
  onAddAgent = null,
  onDelete = null,
  isActive = false,
  depth = 0,
  bridgeType = null,
  nameKnown = true,
  nameBlockedBySignIn = false,
}: {
  label: string;
  /** Whether there is anything under this room to unfold. */
  hasChildren: boolean;
  /** False when `label` is a stand-in because the room's name has not loaded.
   * Rendered as visibly provisional rather than as the room's name. */
  nameKnown?: boolean;
  /** True when the name is missing because the room's server is signed out —
   * something to act on, not to wait for. */
  nameBlockedBySignIn?: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Open the room's conversation in the main panel. Null for rows that have
   * no room behind them (Unassigned), which stay expand-only. */
  onSelect?: (() => void) | null;
  /** True when this room's conversation is the view currently open. */
  isActive?: boolean;
  /** Open the room's channel in the messaging app, or null when there is no
   * native deeplink (room not bridged / link unknown). */
  onOpenChannel?: (() => void) | null;
  /** Add an agent to this room. Null for rows with no room behind them
   * (Unassigned), or where membership is not editable from here. */
  onAddAgent?: (() => void) | null;
  /** Delete the room. Null unless the signed-in user may — the gateway allows
   * its owner and admins, and offering it to anyone else only earns a refusal. */
  onDelete?: (() => void) | null;
  depth?: number;
  /** Bridge platform type (`slack`, `mattermost`, …) when the room is bridged. */
  bridgeType?: string | null;
}) {
  const channelLinkable = onOpenChannel !== null && hasBridgeIcon(bridgeType);
  const hasRoomActions = onAddAgent !== null || channelLinkable || onDelete !== null;
  return (
    <SidebarMenuRow
      className={cn(
        'group/room flex items-center gap-[9px]',
        onSelect === null && 'cursor-default'
      )}
      isActive={isActive}
      // Indent on the content below, not here, so the highlight still spans the
      // sidebar's full width at every depth.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect ?? undefined}
    >
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        style={{ marginLeft: depthIndent(depth).paddingLeft }}
      >
        {hasBridgeIcon(bridgeType) ? (
          <BridgeIcon bridgeType={bridgeType} size={16} className="h-4 w-4" />
        ) : (
          <DoorOpen className="h-4 w-4 text-foreground-muted" />
        )}
      </span>
      {nameKnown ? (
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 flex-1 truncate text-sm text-foreground-muted italic">
                {label}
              </span>
            }
          />
          <TooltipContent>
            {nameBlockedBySignIn
              ? 'Sign in to this room’s server to see its name. Shown by id until then.'
              : 'This room’s name hasn’t loaded yet — shown by id until it does.'}
          </TooltipContent>
        </Tooltip>
      )}
      {hasRoomActions && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarItemMiniButton
                type="button"
                aria-label={`Actions for ${label}`}
                className="opacity-0 transition-opacity duration-150 group-hover/room:opacity-100 data-[popup-open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </SidebarItemMiniButton>
            }
          />
          <DropdownMenuContent align="end">
            {onAddAgent && (
              <DropdownMenuItem onClick={onAddAgent}>
                <Plus className="size-4" />
                Add an agent to this room
              </DropdownMenuItem>
            )}
            {channelLinkable && (
              <DropdownMenuItem onClick={() => onOpenChannel?.()}>
                <BridgeIcon bridgeType={bridgeType} size={16} className="size-4" />
                Open in {bridgePlatformLabel(bridgeType)}
              </DropdownMenuItem>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 className="size-4" />
                  Delete room…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasChildren && (
        <SidebarItemMiniButton
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          aria-expanded={expanded}
          className="opacity-0 transition-opacity duration-150 group-hover/room:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight
            className={cn('h-4 w-4 transition-transform duration-150', expanded && 'rotate-90')}
          />
        </SidebarItemMiniButton>
      )}
    </SidebarMenuRow>
  );
}

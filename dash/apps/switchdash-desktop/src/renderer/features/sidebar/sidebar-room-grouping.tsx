import { ChevronRight, DoorOpen, ExternalLink, Plus } from 'lucide-react';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { openRoomChannel, openRoomGatewayPage } from '@renderer/features/switch-rooms/room-links';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { appState } from '@renderer/lib/stores/app-state';
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

/** Open a room's detail page in the gateway web app (no-op for Unassigned). */
export function openRoomInGateway(roomKey: string): void {
  if (roomKey === UNASSIGNED_ROOM_KEY) return;
  openRoomGatewayPage(roomKey);
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
  onSelect = null,
  onAddAgent = null,
  isActive = false,
  depth = 0,
  bridgeType = null,
  undrawableCount = null,
  nameKnown = true,
  nameBlockedBySignIn = false,
}: {
  label: string;
  count: number;
  /** False when `label` is a stand-in because the room's name has not loaded.
   * Rendered as visibly provisional rather than as the room's name. */
  nameKnown?: boolean;
  /** True when the name is missing because the room's server is signed out —
   * something to act on, not to wait for. */
  nameBlockedBySignIn?: boolean;
  /** Members the server counts that this install cannot draw — agents
   * registered on another switchdash, plus any whose membership failed to load.
   * Disclosed next to the count so a member that exists but cannot be shown is
   * not read as a member that is not there. Null when unknown. */
  undrawableCount?: number | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenGateway: () => void;
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
  depth?: number;
  /** Bridge platform type (`slack`, `mattermost`, …) when the room is bridged. */
  bridgeType?: string | null;
}) {
  const channelLinkable = onOpenChannel !== null && hasBridgeIcon(bridgeType);
  return (
    <SidebarMenuRow
      className="group/room flex h-8 items-center gap-1 px-1"
      isActive={isActive}
      style={depthIndent(depth)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect ?? onToggle}
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
      {channelLinkable && (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarItemMiniButton
                type="button"
                aria-label={`Open ${label} in ${bridgePlatformLabel(bridgeType)}`}
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
          <TooltipContent>Open in {bridgePlatformLabel(bridgeType)}</TooltipContent>
        </Tooltip>
      )}
      {onAddAgent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarItemMiniButton
                type="button"
                aria-label={`Add an agent to ${label}`}
                className="opacity-0 transition-opacity duration-150 group-hover/room:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddAgent();
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </SidebarItemMiniButton>
            }
          />
          <TooltipContent>Add an agent to this room</TooltipContent>
        </Tooltip>
      )}
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
      <span className="shrink-0 text-xs text-foreground-tertiary-passive">{count}</span>
      {undrawableCount !== null && undrawableCount > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="shrink-0 text-xs text-foreground-muted">+{undrawableCount}</span>
            }
          />
          <TooltipContent>
            {undrawableCount} more {undrawableCount === 1 ? 'member is' : 'members are'} in this
            room but not on this copy of Switch Console, so they cannot be shown here
          </TooltipContent>
        </Tooltip>
      )}
    </SidebarMenuRow>
  );
}

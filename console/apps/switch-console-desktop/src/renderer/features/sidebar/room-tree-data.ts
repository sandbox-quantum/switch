import { isProvisioned, type SessionStore } from '@renderer/features/sessions/stores/session-store';
import type { SidebarRoomSortBy } from '@shared/view-state';
import { UNBRIDGED_FILTER_VALUE } from '@shared/view-state';
import { getSortInstant } from './sidebar-store';

/**
 * What the room view needs to know about a room to order and filter it, without
 * reaching into stores. Kept as plain data so the rules below are testable on
 * their own — they are the part that decides what you can and cannot see.
 */
export type RoomGroup = {
  roomKey: string;
  label: string;
  /** Bridge platform (`slack`, `mattermost`, …), or null when not bridged. */
  bridgeType: string | null;
  /** When the room was created, if its server's room list has been read. */
  createdAt: string | null;
  sessions: SessionStore[];
};

/** The value a room is filtered by in the messaging-app dimension. Unbridged
 * rooms get a sentinel rather than being unfilterable. */
export function bridgeFilterValue(bridgeType: string | null): string {
  return bridgeType ?? UNBRIDGED_FILTER_VALUE;
}

export type RoomFilters = {
  /** Bridge types (and {@link UNBRIDGED_FILTER_VALUE}) to keep. Empty = keep all. */
  bridgeTypes: ReadonlySet<string>;
  /** Keep only rooms with a running session in them. */
  hasLiveSession: boolean;
};

/** Whether any room filter is set. */
export function hasRoomFilters(filters: RoomFilters): boolean {
  return filters.bridgeTypes.size > 0 || filters.hasLiveSession;
}

/**
 * Apply the room filters. Dimensions are ANDed, values within one ORed — the
 * same rule the agent filters follow.
 */
export function filterRoomGroups(groups: RoomGroup[], filters: RoomFilters): RoomGroup[] {
  if (!hasRoomFilters(filters)) return groups;
  return groups.filter((group) => {
    if (
      filters.bridgeTypes.size > 0 &&
      !filters.bridgeTypes.has(bridgeFilterValue(group.bridgeType))
    ) {
      return false;
    }
    if (filters.hasLiveSession && !group.sessions.some(isProvisioned)) return false;
    return true;
  });
}

/** The most recent session activity in a room, or null when nothing has run in
 * it. Rooms are places: plenty of them have no activity at all, and that is the
 * case ordering has to handle rather than treat as a missing value. */
function lastActivity(group: RoomGroup): string | null {
  let latest: string | null = null;
  for (const session of group.sessions) {
    const instant = getSortInstant(session, 'updated');
    if (instant && (latest === null || instant > latest)) latest = instant;
  }
  return latest;
}

/**
 * Order rooms for the room view.
 *
 * `created-at` and `updated-at` put the most recent first, matching the session
 * sort. A room the sort key is unknown for (never loaded, or never used) sorts
 * below every room that has one, then by name, so the ordering stays stable
 * instead of shuffling as data arrives.
 */
export function sortRoomGroups(groups: RoomGroup[], sortBy: SidebarRoomSortBy): RoomGroup[] {
  const key =
    sortBy === 'created-at'
      ? (group: RoomGroup) => group.createdAt
      : sortBy === 'updated-at'
        ? lastActivity
        : () => null;
  return [...groups].sort((a, b) => {
    const ak = key(a);
    const bk = key(b);
    if (ak !== bk) {
      if (ak === null) return 1;
      if (bk === null) return -1;
      return bk.localeCompare(ak);
    }
    return a.label.localeCompare(b.label);
  });
}

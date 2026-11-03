import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

/** Group key for a room with no messaging app behind it. */
const UNBRIDGED = '';

export type RoomGroup = {
  key: string;
  label: string;
  bridgeType: string | null;
  rooms: RemoteRoomSummary[];
};

/**
 * Rooms under the messaging app they are reachable in.
 *
 * Which app a room is in is the thing people scan this page for — it decides
 * where a conversation actually happens — so it is the heading rather than a
 * column. Grouped by the bridge's own display name, because a server can have
 * two of the same platform (two Slack workspaces) and calling both "Slack"
 * would merge two different places into one list. Rooms in no app, which
 * live in Switch Console, sort last: they are the exception, and leading with
 * them buries the rest.
 */
export function groupByMessagingApp(rooms: RemoteRoomSummary[]): RoomGroup[] {
  const groups = new Map<string, RoomGroup>();
  for (const room of rooms) {
    const key = room.bridgeType ? (room.bridgeDisplayName ?? room.bridgeType) : UNBRIDGED;
    const existing = groups.get(key);
    if (existing) {
      existing.rooms.push(room);
      continue;
    }
    groups.set(key, {
      key,
      label: room.bridgeType
        ? (room.bridgeDisplayName ?? bridgePlatformLabel(room.bridgeType))
        : 'Switch Console',
      bridgeType: room.bridgeType ?? null,
      rooms: [room],
    });
  }
  for (const group of groups.values()) {
    group.rooms.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNBRIDGED) return 1;
    if (b.key === UNBRIDGED) return -1;
    return a.label.localeCompare(b.label);
  });
}

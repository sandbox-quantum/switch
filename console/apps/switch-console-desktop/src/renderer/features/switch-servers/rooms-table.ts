import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import {
  type RemoteRoomSummary,
  type RoomAccess,
  roomAccessOf,
} from '@shared/core/switch-servers/switch-servers';

/** One room as the Rooms table shows it. */
export type RoomRow = {
  id: string;
  name: string;
  /** The messaging app it lives in, by its own name ("Acme Slack"), or Switch Console. */
  appLabel: string;
  bridgeType: string | null;
  /** A private channel on its app, or a Console chat, which only its members reach. */
  privateChannel: boolean;
  isConsoleChat: boolean;
  groupId: string | null;
  groupName: string | null;
  /** "You" for your own rooms; null when the server names no owner. */
  ownerLabel: string | null;
  /** Null when the server does not say. */
  access: RoomAccess | null;
  agentCount: number;
  /** Null when the server does not say. */
  peopleCount: number | null;
  createdAt: string;
  /** You own it, take part in it, or have an agent in it. */
  mine: boolean;
  archived: boolean;
};

/** The short word the table shows for a room's access; the full sentence is its tooltip. */
export const ACCESS_SHORT: Record<RoomAccess, string> = {
  public: 'Open',
  read_only: 'Read-only',
  private: 'Private',
};

export const CONSOLE_APP_LABEL = 'Switch Console';

export function roomRow(room: RemoteRoomSummary, viewerId: string | null): RoomRow {
  const isConsoleChat = room.isConsoleChat;
  return {
    id: room.id,
    name: room.name,
    appLabel: room.bridgeType
      ? (room.bridgeDisplayName ?? bridgePlatformLabel(room.bridgeType))
      : CONSOLE_APP_LABEL,
    bridgeType: room.bridgeType,
    privateChannel: isConsoleChat || room.channelType === 'channel_private',
    isConsoleChat,
    groupId: room.groupId ?? null,
    groupName: room.groupName ?? null,
    ownerLabel: viewerId !== null && room.ownerId === viewerId ? 'You' : (room.ownerName ?? null),
    // A Console chat is made readable only by its members.
    access: isConsoleChat
      ? 'private'
      : room.readVisibility && room.writeVisibility
        ? roomAccessOf(room.readVisibility, room.writeVisibility)
        : null,
    agentCount: room.agentCount,
    peopleCount: room.connectedUserCount ?? null,
    createdAt: room.createdAt,
    mine: room.viewerIsMember,
    archived: room.archived,
  };
}

export type RoomsFilter = {
  query: string;
  /** An app label, or null for any. */
  app: string | null;
  /** A group id, or null for any. */
  groupId: string | null;
};

export const NO_FILTER: RoomsFilter = { query: '', app: null, groupId: null };

/** The rows that match the search and the app and group picked, in name order. */
export function filterRoomRows(rows: readonly RoomRow[], filter: RoomsFilter): RoomRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows
    .filter((row) => query === '' || row.name.toLowerCase().includes(query))
    .filter((row) => filter.app === null || row.appLabel === filter.app)
    .filter((row) => filter.groupId === null || row.groupId === filter.groupId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The apps the rows live in, each once, in name order, Switch Console last. */
export function appOptions(rows: readonly RoomRow[]): string[] {
  const labels = [...new Set(rows.map((row) => row.appLabel))];
  return labels.sort((a, b) =>
    a === CONSOLE_APP_LABEL ? 1 : b === CONSOLE_APP_LABEL ? -1 : a.localeCompare(b)
  );
}

/** The groups the rows are filed under, each once, in name order. */
export function groupOptions(rows: readonly RoomRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (row.groupId !== null) byId.set(row.groupId, row.groupName ?? 'Unnamed group');
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

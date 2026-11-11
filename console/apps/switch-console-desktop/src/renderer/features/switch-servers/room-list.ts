import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import {
  type RemoteRoomSummary,
  type RoomAccess,
  roomAccessOf,
} from '@shared/core/switch-servers/switch-servers';

/** One room as the Rooms page shows it, on its card. */
export type RoomCard = {
  id: string;
  name: string;
  description: string;
  /**
   * Which messaging app connection it is on, or Switch Console: the
   * connection's id, so two Slack workspaces stay two choices even under the
   * same name.
   */
  appKey: string;
  /** The connection's own name ("Acme Slack"), or Switch Console. */
  appLabel: string;
  bridgeType: string | null;
  /** A private channel on its app, or a Console chat, which only its members reach. */
  privateChannel: boolean;
  isConsoleChat: boolean;
  groupId: string | null;
  groupName: string | null;
  ownedByYou: boolean;
  /** Null when the server names no owner. */
  ownerName: string | null;
  /** Null when the server does not say. */
  access: RoomAccess | null;
  agentCount: number;
  /** Null when not known: the server counts only the people on a room's messaging app. */
  peopleCount: number | null;
  createdAt: string;
  /** You own it, take part in it, or have an agent in it. */
  mine: boolean;
  archived: boolean;
};

/** The short word a card shows for a room's access; the full sentence is its tooltip. */
export const ACCESS_SHORT: Record<RoomAccess, string> = {
  public: 'Open',
  read_only: 'Read-only',
  private: 'Private',
};

export const CONSOLE_APP_LABEL = 'Switch Console';
const CONSOLE_APP_KEY = 'switch-console';

export function roomCard(
  room: RemoteRoomSummary,
  viewer: {
    id: string | null;
    /** Rooms Console lists as yours, for a server that does not say which are. */
    listedIds?: ReadonlySet<string>;
  }
): RoomCard {
  const isConsoleChat = room.isConsoleChat;
  const bridged = room.bridgeType !== null;
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    appKey: bridged
      ? (room.bridgeId ?? `${room.bridgeType}:${room.bridgeDisplayName ?? ''}`)
      : CONSOLE_APP_KEY,
    appLabel: bridged
      ? (room.bridgeDisplayName ?? bridgePlatformLabel(room.bridgeType))
      : CONSOLE_APP_LABEL,
    bridgeType: room.bridgeType,
    privateChannel: isConsoleChat || room.channelType === 'channel_private',
    isConsoleChat,
    groupId: room.groupId ?? null,
    groupName: room.groupName ?? null,
    ownedByYou: viewer.id !== null && room.ownerId === viewer.id,
    ownerName: room.ownerName ?? null,
    // A Console chat is made readable only by its members.
    access: isConsoleChat
      ? 'private'
      : room.readVisibility && room.writeVisibility
        ? roomAccessOf(room.readVisibility, room.writeVisibility)
        : null,
    agentCount: room.agentCount,
    peopleCount: peopleCount(room, bridged, isConsoleChat),
    createdAt: room.createdAt,
    // Yours as the sidebar counts it, owned or taken part in, plus what it lists as
    // yours on a server that does not say: an archived room is in no sidebar.
    mine:
      (viewer.id !== null && room.ownerId === viewer.id) ||
      room.viewerIsMember ||
      (viewer.listedIds?.has(room.id) ?? false),
    archived: room.archived,
  };
}

/**
 * How many people a room has, or null when not known. The server counts the
 * accounts on a bridged room's app and, where it says `peopleAreMembers`, a
 * Console chat's members, 0 included. Any other room with no app always reads 0
 * whoever is in it, as does a chat on a server from before it counted members
 * (a chat always has one): not known, rather than none.
 */
function peopleCount(
  room: RemoteRoomSummary,
  bridged: boolean,
  isConsoleChat: boolean
): number | null {
  const count = room.connectedUserCount ?? null;
  if (bridged) return count;
  if (room.peopleAreMembers === true) return count;
  if (isConsoleChat && room.peopleAreMembers === undefined)
    return count !== null && count > 0 ? count : null;
  return null;
}

/** "Owned by you", "Owned by Ada", or null when the server names no owner. */
export function ownerText(card: Pick<RoomCard, 'ownedByYou' | 'ownerName'>): string | null {
  if (card.ownedByYou) return 'Owned by you';
  return card.ownerName ? `Owned by ${card.ownerName}` : null;
}

export function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export type RoomsFilter = {
  query: string;
  /** An app key, or null for any. */
  app: string | null;
  /** A group id, or null for any. */
  groupId: string | null;
};

export const NO_FILTER: RoomsFilter = { query: '', app: null, groupId: null };

export type AppOption = { value: string; label: string; bridgeType: string | null };

/** The rooms that match the search and the app and group picked, in name order. */
export function filterRoomCards(cards: readonly RoomCard[], filter: RoomsFilter): RoomCard[] {
  const query = filter.query.trim().toLowerCase();
  return cards
    .filter((card) => query === '' || card.name.toLowerCase().includes(query))
    .filter((card) => filter.app === null || card.appKey === filter.app)
    .filter((card) => filter.groupId === null || card.groupId === filter.groupId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Each app connection the rooms are on, once, by name, Switch Console last. */
export function appOptions(cards: readonly RoomCard[]): AppOption[] {
  const byKey = new Map<string, AppOption>();
  for (const card of cards) {
    if (!byKey.has(card.appKey))
      byKey.set(card.appKey, {
        value: card.appKey,
        label: card.appLabel,
        bridgeType: card.bridgeType,
      });
  }
  return [...byKey.values()].sort((a, b) =>
    a.value === CONSOLE_APP_KEY
      ? 1
      : b.value === CONSOLE_APP_KEY
        ? -1
        : a.label.localeCompare(b.label)
  );
}

/** The groups the rooms are filed under, each once, in name order. */
export function groupOptions(cards: readonly RoomCard[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const card of cards) {
    if (card.groupId !== null) byId.set(card.groupId, card.groupName ?? 'Unnamed group');
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `filter` without an app or group no longer offered: one picked among the
 * active rooms that has none archived, say. Kept, it would hide every room
 * while its dropdown, which lists only what is offered, read "Any".
 */
export function offeredFilter(
  filter: RoomsFilter,
  apps: readonly AppOption[],
  groups: readonly { id: string }[]
): RoomsFilter {
  const app = filter.app !== null && apps.some((each) => each.value === filter.app);
  const group = filter.groupId !== null && groups.some((each) => each.id === filter.groupId);
  return {
    query: filter.query,
    app: app ? filter.app : null,
    groupId: group ? filter.groupId : null,
  };
}

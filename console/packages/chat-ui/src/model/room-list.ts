type RoomSummary = {
  id: string;
  name: string;
  description: string;
  bridgeType: string | null;
  bridgeDisplayName: string | null;
  bridgeId?: string | null;
  channelType: string | null;
  isConsoleChat: boolean;
  groupId?: string | null;
  groupName?: string | null;
  ownerId: string | null;
  ownerName?: string | null;
  readVisibility?: 'public' | 'private';
  agentCount: number;
  connectedUserCount?: number;
  viewerIsMember: boolean;
  peopleAreMembers?: boolean;
  createdAt: string;
  archived: boolean;
};

export type RoomCard = {
  id: string;
  name: string;
  description: string;
  appKey: string;
  appLabel: string;
  bridgeType: string | null;
  privateChannel: boolean;
  isConsoleChat: boolean;
  groupId: string | null;
  groupName: string | null;
  ownedByYou: boolean;
  ownerName: string | null;
  access: 'public' | 'private' | null;
  agentCount: number;
  peopleCount: number | null;
  createdAt: string;
  mine: boolean;
  archived: boolean;
};

export const ACCESS_SHORT: Record<'public' | 'private', string> = {
  public: 'Public',
  private: 'Private',
};

export const CONSOLE_APP_LABEL = 'Switch Console';
const CONSOLE_APP_KEY = 'switch-console';

function roomAccessOf(read: 'public' | 'private'): 'public' | 'private' {
  return read === 'private' ? 'private' : 'public';
}

function bridgePlatformLabel(type: string | null): string {
  if (!type) return '';
  const labels: Record<string, string> = {
    slack: 'Slack',
    mattermost: 'Mattermost',
    discord: 'Discord',
    teams: 'Teams',
    telegram: 'Telegram',
  };
  return labels[type] ?? type;
}

export function roomCard(
  room: RoomSummary,
  viewer: {
    id: string | null;
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
    access: isConsoleChat
      ? 'private'
      : room.readVisibility
        ? roomAccessOf(room.readVisibility)
        : null,
    agentCount: room.agentCount,
    peopleCount: peopleCount(room, bridged, isConsoleChat),
    createdAt: room.createdAt,
    mine:
      (viewer.id !== null && room.ownerId === viewer.id) ||
      room.viewerIsMember ||
      (viewer.listedIds?.has(room.id) ?? false),
    archived: room.archived,
  };
}

function peopleCount(
  room: RoomSummary,
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

export function ownerText(card: Pick<RoomCard, 'ownedByYou' | 'ownerName'>): string | null {
  if (card.ownedByYou) return 'Owned by you';
  return card.ownerName ? `Owned by ${card.ownerName}` : null;
}

export function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export type RoomsFilter = {
  query: string;
  app: string | null;
  groupId: string | null;
};

export const NO_FILTER: RoomsFilter = { query: '', app: null, groupId: null };

export type AppOption = { value: string; label: string; bridgeType: string | null };

export function filterRoomCards(cards: readonly RoomCard[], filter: RoomsFilter): RoomCard[] {
  const query = filter.query.trim().toLowerCase();
  return cards
    .filter((card) => query === '' || card.name.toLowerCase().includes(query))
    .filter((card) => filter.app === null || card.appKey === filter.app)
    .filter((card) => filter.groupId === null || card.groupId === filter.groupId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

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

export function groupOptions(cards: readonly RoomCard[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const card of cards) {
    if (card.groupId !== null) byId.set(card.groupId, card.groupName ?? 'Unnamed group');
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

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

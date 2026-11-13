import type { ChatSummary } from '@shared/core/chats/chats';

/**
 * When a room last saw something happen, for putting the liveliest first: a
 * Switch Console room's newest message, which Console sees. A messaging-app
 * room's messages Console does not see, so its creation stands in. Empty when
 * neither is known, which sorts last.
 */
export function roomActivityAt(
  chat: Pick<ChatSummary, 'lastMessage'> | undefined,
  createdAt: string | null | undefined
): string {
  return chat?.lastMessage?.sentAt ?? createdAt ?? '';
}

/**
 * Rooms with unread messages first, then the most recently active, then by
 * name. Returns a new array.
 */
export function byActivity<T>(
  rooms: readonly T[],
  of: (room: T) => { name: string; activityAt: string; unread: boolean }
): T[] {
  const keyed = rooms.map((room) => ({ room, key: of(room) }));
  keyed.sort(
    (a, b) =>
      Number(b.key.unread) - Number(a.key.unread) ||
      b.key.activityAt.localeCompare(a.key.activityAt) ||
      a.key.name.localeCompare(b.key.name)
  );
  return keyed.map(({ room }) => room);
}

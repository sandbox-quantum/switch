import type { ChatSummary } from '@shared/core/chats/chats';

/**
 * When a room last saw something happen, for putting the liveliest first, in
 * milliseconds; 0 when nothing is known, which sorts last. The newest of what
 * is known: a Switch Console room's newest message as Console saw it, the
 * room's last message as the server reports it (a messaging-app room's
 * included, whose messages Console never sees), or failing both, when the
 * room was made.
 */
export function roomActivityAt(
  chat: Pick<ChatSummary, 'lastMessage'> | undefined,
  room: { createdAt?: string | null; lastMessageAt?: string | null } | null | undefined
): number {
  const seen = Math.max(time(chat?.lastMessage?.sentAt), time(room?.lastMessageAt));
  return seen > 0 ? seen : time(room?.createdAt);
}

function time(iso: string | null | undefined): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Rooms with unread messages first, then the most recently active, then by
 * name. Returns a new array.
 */
export function byActivity<T>(
  rooms: readonly T[],
  of: (room: T) => { name: string; activityAt: number; unread: boolean }
): T[] {
  const keyed = rooms.map((room) => ({ room, key: of(room) }));
  keyed.sort(
    (a, b) =>
      Number(b.key.unread) - Number(a.key.unread) ||
      b.key.activityAt - a.key.activityAt ||
      a.key.name.localeCompare(b.key.name)
  );
  return keyed.map(({ room }) => room);
}

/**
 * `ordered` with the open room `openId` back at `place`: a room counts as
 * read while it is open, and each message in it makes it the newest, so
 * left to the order it would jump away under the cursor the moment it is
 * clicked. It takes its place in the order again once it is closed.
 */
export function holdingOpenRoom<T extends { id: string }>(
  ordered: T[],
  openId: string | null,
  place: number | null
): T[] {
  if (openId === null || place === null) return ordered;
  const open = ordered.find((room) => room.id === openId);
  if (!open) return ordered;
  const rest = ordered.filter((room) => room !== open);
  rest.splice(Math.min(place, rest.length), 0, open);
  return rest;
}

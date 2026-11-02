import type { AgentSharedSession } from '@shared/core/switch-servers/switch-servers';

/**
 * How an agent's shared session stands in one room, in words for its
 * participant card: where the session is based and how many rooms share it.
 * Null when the session does not cover the room: the agent shares none, or the
 * room is isolated and has a session of its own.
 */
export function roomSharingLabel(
  sharing: Pick<AgentSharedSession, 'homeRoomId' | 'sharedRoomIds'> | null | undefined,
  roomId: string,
  roomName: (roomId: string) => string
): string | null {
  const home = sharing?.homeRoomId;
  if (!sharing || !home) return null;
  const others = sharing.sharedRoomIds.filter((id) => id !== home);
  if (roomId !== home && !others.includes(roomId)) return null;
  const rooms = others.length + 1;
  const where = roomId === home ? 'based here' : `based in ${roomName(home)}`;
  return `Shared session, ${where} · ${rooms} ${rooms === 1 ? 'room' : 'rooms'}`;
}

/**
 * A session the host pinned to one room cannot claim another.
 *
 * A resident host runs many rooms in one process, one conversation each, and its
 * room-to-session map is what keeps a room's traffic out of another room's
 * conversation. A session that moved would silently take its own room's messages
 * with it.
 *
 * This has to answer before the claim is sent. Switch grants a room the moment
 * it is asked and may evict whoever held it, so a refusal that arrives after the
 * call has already done the damage it exists to prevent.
 */
export function boundRoomRefusal(requested: unknown, bound: string | undefined): string | null {
  const pinned = bound?.trim();
  if (!pinned || typeof requested !== 'string' || requested === pinned) return null;
  return `This session is bound to room ${pinned} and cannot connect to ${requested}. It runs inside an always-on agent host that keeps one conversation per room; another room's work belongs to that room's own session.`;
}

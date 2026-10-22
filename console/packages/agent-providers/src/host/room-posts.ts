/**
 * The Switch tools that put something the agent wrote in front of a room: a
 * turn that called one of them has answered, if the post reached the room the
 * turn came from. Each can name a room; the watcher fills in the one a call
 * reached (`POSTED_ROOM_META`), and a server that reports it says so too.
 */
export const ROOM_POSTING_TOOLS = new Set([
  'post_message',
  'send_targeted_message',
  'send_attachment',
]);

/** The `_meta` key the watcher puts on a post's result: the room it reached. */
export const POSTED_ROOM_META = 'switch/room_id';

/**
 * Whether a Switch tool result is a post that landed: null when it is not,
 * else the room it reached when the result says (`roomId` absent when not).
 */
export function postedToRoom(name: string, result: unknown): { roomId?: string } | null {
  if (!ROOM_POSTING_TOOLS.has(name)) return null;
  if (typeof result !== 'object' || result === null) return null;
  const landed = result as {
    isError?: unknown;
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
  if (landed.isError === true) return null;
  const roomId = landed._meta?.[POSTED_ROOM_META] ?? landed.structuredContent?.room_id;
  return typeof roomId === 'string' && roomId ? { roomId } : {};
}

/**
 * The `<scheme>://session?…` link that opens one session in Switch Console.
 *
 * Switch Console owns this shape — switch-core relays it verbatim, and rewrites
 * it into an https redirect for platforms that will not linkify a custom
 * scheme, so a link posted into a room is clickable wherever the room is
 * bridged.
 *
 * Resolution is by session id, which resolves on any client; `server` and
 * `agent` are advisory, and `room` is empty for a session attending none.
 */
export function buildSessionDeeplink(args: {
  scheme: string;
  apiEndpoint: string;
  agentId: string;
  roomId: string | null;
  sessionId: string;
}): string {
  const params = new URLSearchParams({
    server: args.apiEndpoint,
    agent: args.agentId,
    room: args.roomId ?? '',
    session: args.sessionId,
  });
  return `${args.scheme}://session?${params.toString()}`;
}

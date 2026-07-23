/**
 * Choose the session a deeplink targets. A session id resolves the exact
 * session on any client, so when one is present we use ONLY the id match — never
 * a room-based guess, which would open a different session that merely shares the
 * room (the wrong chat, CHOO-1588). Older links that carried no session id fall
 * back to room matching. Resolvers are lazy so the unused one isn't run.
 */
export function pickDeeplinkTarget<T>(
  sessionId: string,
  resolveById: () => T | null,
  resolveByRoom: () => T | null
): T | null {
  return sessionId ? resolveById() : resolveByRoom();
}

/**
 * The copies of CLI conversations being made for new sessions right now, by
 * session id, each settling with the copy's id once the session's row holds
 * it. A session's row is saved before its copy is made, so something can
 * start the session in between; it waits here for the copy rather than take
 * the missing id for a copy that was never made.
 *
 * In memory only: a copy in flight belongs to this run of Console, and one
 * that a restart cut short was never recorded.
 */
const inFlight = new Map<string, Promise<string>>();

/** Records `copy` as the copy being made for `sessionId` until it settles, and returns it. */
export function trackCliConversationFork(
  sessionId: string,
  copy: Promise<string>
): Promise<string> {
  inFlight.set(sessionId, copy);
  const settled = () => {
    if (inFlight.get(sessionId) === copy) inFlight.delete(sessionId);
  };
  copy.then(settled, settled);
  return copy;
}

/** The copy being made for this session, or undefined when none is. */
export function cliConversationForkInFlight(sessionId: string): Promise<string> | undefined {
  return inFlight.get(sessionId);
}

/**
 * Tracks when a human last sent keystrokes to a PTY session, so the Switch
 * notification poller can hold off injecting a room message into the pane while
 * the operator is actively typing — otherwise the injected text and its
 * trailing Enter interleave with what they're typing (CHOO-1059 dual-writer
 * gate). Keyed by the same pty session id the injection sink writes to.
 */

const HUMAN_INPUT_IDLE_MS = 1500;

const lastInputAt = new Map<string, number>();

/** Record that the operator just sent input to this session. */
export function recordHumanInput(sessionId: string): void {
  lastInputAt.set(sessionId, Date.now());
}

/** True if the operator typed into this session within the idle window. */
export function isHumanInputRecent(sessionId: string): boolean {
  const at = lastInputAt.get(sessionId);
  return at !== undefined && Date.now() - at < HUMAN_INPUT_IDLE_MS;
}

/** Forget a session's activity (on stop) so the map doesn't grow unbounded. */
export function clearHumanInput(sessionId: string): void {
  lastInputAt.delete(sessionId);
}

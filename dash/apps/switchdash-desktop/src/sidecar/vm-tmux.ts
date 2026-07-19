/**
 * Bundle-safe tmux helpers, replicated from switchdash's Electron-bound
 * `tmux-session-name.ts` so the sidecar bundle stays free of the main-process
 * logger. A spawned session's tmux name matches what switchdash would compute
 * for the same session, so a later attach reuses the pane.
 */

/** tmux resolves a bare `-t name` by prefix; `=` forces an exact-name match. */
export function exactTmuxTarget(sessionName: string): string {
  return `=${sessionName}`;
}

/** Same scheme as switchdash's `makeTmuxSessionName`. */
export function makeTmuxSessionName(sessionId: string): string {
  return `switchdash-${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
}

/**
 * Agent pane name, keyed on the shared session id alone. Mirrors switchdash's
 * `makeAgentTmuxSessionName` so the sidecar and every attached client converge
 * on ONE pane per session (CHOO-1181). Must not fold in projectId — it is
 * switchdash-instance-local and would diverge per client.
 */
export function makeAgentTmuxSessionName(sessionId: string): string {
  return makeTmuxSessionName(`session-${sessionId}`);
}

const AGENT_PANE_PREFIX = 'session-';

/**
 * Inverse of `makeAgentTmuxSessionName`: recover the session id from a tmux
 * session name, or null if the name isn't an agent pane (the sidecar's own
 * `switchdash-sidecar-*` session, a terminal pane, or anything else). Lets the
 * sidecar enumerate live agent panes to report sessions that never joined a
 * room (CHOO-1181).
 */
export function parseAgentTmuxSessionName(sessionName: string): string | null {
  if (!sessionName.startsWith('switchdash-')) return null;
  const encoded = sessionName.slice('switchdash-'.length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(AGENT_PANE_PREFIX)) return null;
  const sessionId = decoded.slice(AGENT_PANE_PREFIX.length);
  return sessionId || null;
}

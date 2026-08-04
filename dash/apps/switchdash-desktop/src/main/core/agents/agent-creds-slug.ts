import type { Session } from '@shared/core/sessions/sessions';

/**
 * The per-agent key its Switch credentials live under: `.switch/agents/<slug>.json`
 * (CHOO-1440). Every writer keys by the agent's `name`, so every reader must too.
 *
 * `session.agentName` is the agent row's live `name`, joined on every session load
 * rather than frozen into the row, so it already follows a rename — re-reading the
 * agent here could only return the same value. The agent id is a last-resort
 * fallback for a session built without a name.
 *
 * This is the derivation for readers that hold a session: the launch paths, the
 * sidecar and the remote preflight. Readers that hold an agent row instead (the
 * auto-session watcher, the notification poller) take the same key from `name`
 * directly — the key-space is shared even though the input differs.
 */
export function agentCredsSlug(session: Session): string {
  return session.agentName ?? session.agentId;
}

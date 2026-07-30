import type { Session } from '@shared/core/sessions/sessions';

/**
 * The per-agent key its Switch credentials live under: `.switch/agents/<slug>.json`
 * (CHOO-1440). Every writer keys by the agent's `name`, so every reader must too.
 *
 * `session.agentName` is the agent row's live `name`, joined on every session load
 * rather than frozen into the row, so it already follows a rename — re-reading the
 * agent here could only return the same value. The agent id is a last-resort
 * fallback for a session built without a name. Kept in one place so the launch
 * paths, the sidecar and the remote preflight cannot drift onto different
 * key-spaces.
 */
export function agentCredsSlug(session: Session): string {
  return session.agentName ?? session.agentId;
}

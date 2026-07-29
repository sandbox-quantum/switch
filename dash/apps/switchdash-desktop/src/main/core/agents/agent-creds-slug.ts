import type { Agent } from '@shared/core/agents/agents';
import type { Session } from '@shared/core/sessions/sessions';
import { getAgentById } from './getAgentById';

/**
 * The per-agent key its Switch credentials live under: `.switch/agents/<slug>.json`
 * (CHOO-1440). Every writer keys by the agent's `name`, so every reader must too.
 *
 * The agent row is preferred over the session's denormalised `agentName` because
 * it is the source of truth, and the local agent id is a last-resort fallback for
 * a row that predates named agents. Kept in one place so the launch paths, the
 * sidecar, and the remote preflight can never drift onto different key-spaces.
 */
export function agentCredsSlug(
  agent: Pick<Agent, 'name'> | null | undefined,
  session: Session
): string {
  return agent?.name ?? session.agentName ?? session.agentId;
}

/** {@link agentCredsSlug} for a caller that has not already loaded the agent row. */
export async function resolveAgentCredsSlug(session: Session): Promise<string> {
  return agentCredsSlug(await getAgentById(session.agentId), session);
}

import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents, sessions, type SessionRow } from '@main/db/schema';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type SessionWithAgent = {
  row: SessionRow;
  locationId: string;
  providerId: AgentProviderId;
};

/**
 * Loads a session row joined with its owning agent, exposing the agent's
 * `locationId` and `providerId` (denormalised onto the session view).
 */
export async function loadSessionWithAgent(
  sessionId: string
): Promise<SessionWithAgent | undefined> {
  const [joined] = await db
    .select({ session: sessions, locationId: agents.locationId, providerId: agents.providerId })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!joined) return undefined;
  return { row: joined.session, locationId: joined.locationId, providerId: joined.providerId };
}

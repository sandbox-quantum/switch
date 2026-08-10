import { eq, sql } from 'drizzle-orm';
import { mapSessionRowToSession } from '@main/core/sessions/utils/utils';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import type { Session } from '@shared/core/sessions/sessions';

export async function restoreSession(id: string): Promise<Session | undefined> {
  const [updatedRow] = await db
    .update(sessions)
    .set({
      archivedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, id))
    .returning();

  if (!updatedRow) return undefined;

  const [agent] = await db
    .select({ providerId: agents.providerId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, updatedRow.agentId))
    .limit(1);
  if (!agent) return undefined;

  return mapSessionRowToSession(updatedRow, agent.providerId, agent.name);
}

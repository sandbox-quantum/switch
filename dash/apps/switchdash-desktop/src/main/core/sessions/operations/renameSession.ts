import { err, ok, type Result } from '@switchdash/shared';
import { eq, sql } from 'drizzle-orm';
import { mapSessionRowToSession } from '@main/core/sessions/utils/utils';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import type { RenameSessionError, RenameSessionSuccess } from '@shared/core/sessions/sessions';

export async function renameSession(
  sessionId: string,
  newTitle: string
): Promise<Result<RenameSessionSuccess, RenameSessionError>> {
  const [existing] = await db
    .select({ providerId: agents.providerId })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!existing) return err({ type: 'session-not-found', sessionId });

  const [updatedRow] = await db
    .update(sessions)
    .set({ title: newTitle, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(sessions.id, sessionId))
    .returning();

  return ok({ session: mapSessionRowToSession(updatedRow, existing.providerId) });
}

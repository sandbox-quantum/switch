import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

export async function setInitialPromptDelivery(
  sessionId: string,
  delivery: InitialPromptDelivery
): Promise<void> {
  const [row] = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row)
    throw new Error(`Cannot record initial-prompt delivery: session ${sessionId} is missing.`);

  await db
    .update(sessions)
    .set({ config: { ...(row.config ?? {}), initialPromptDelivery: delivery } })
    .where(eq(sessions.id, sessionId));
  events.emit(sessionChangedChannel, { sessionId, changes: { initialPromptDelivery: delivery } });
}

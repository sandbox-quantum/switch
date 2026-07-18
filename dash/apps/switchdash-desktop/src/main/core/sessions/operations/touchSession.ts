import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

export async function touchSession(sessionId: string, lastInteractedAt: string): Promise<void> {
  await db.update(sessions).set({ lastInteractedAt }).where(eq(sessions.id, sessionId));
}

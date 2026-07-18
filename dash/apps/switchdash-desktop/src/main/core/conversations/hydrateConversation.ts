import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSession } from '../projects/utils';
import { loadSessionWithAgent } from './session-join';
import { mapSessionRowToConversation } from './utils';

export async function hydrateConversation(
  projectId: string,
  sessionId: string,
  conversationId: string
): Promise<void> {
  const session = resolveSession(projectId, sessionId);
  if (!session) throw new Error('Session not found');

  const loaded = await loadSessionWithAgent(conversationId);
  if (!loaded) throw new Error('Conversation not found');
  const row = loaded.row;

  const isFirstSpawn = row.agentSessionId === null;

  if (isFirstSpawn) {
    // Write agent_session_id before spawning — idempotency guard against double-hydrate.
    await db
      .update(sessions)
      .set({ agentSessionId: conversationId })
      .where(eq(sessions.id, conversationId));
  }

  const config = row.config ?? {};
  const isResuming = !isFirstSpawn;

  await session.agent.start(
    mapSessionRowToConversation(row, loaded.projectId, loaded.providerId, isResuming),
    undefined,
    isResuming,
    isFirstSpawn ? config.initialPrompt : undefined
  );
}

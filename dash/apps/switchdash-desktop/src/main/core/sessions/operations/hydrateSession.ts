import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

export async function hydrateSession(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Session not found');

  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error('Session row not found');
  const row = loaded.row;

  const isFirstSpawn = row.agentSessionId === null;

  if (isFirstSpawn) {
    // Write agent_session_id before spawning — idempotency guard against double-hydrate.
    await db.update(sessions).set({ agentSessionId: sessionId }).where(eq(sessions.id, sessionId));
  }

  const config = row.config ?? {};
  const isResuming = !isFirstSpawn;

  await agent.start(
    mapSessionRowToSession(row, loaded.providerId),
    undefined,
    isResuming,
    isFirstSpawn ? config.initialPrompt : undefined
  );
}

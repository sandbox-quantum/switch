import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { isDroidProviderSessionId } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { loadSessionWithAgent } from '../session-join';

export async function saveProviderSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<void> {
  if (!isDroidProviderSessionId(providerSessionId)) {
    log.warn('saveProviderSessionId: ignored invalid Droid session id', {
      sessionId,
      providerSessionId,
    });
    return;
  }

  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) return;

  const config = loaded.row.config ?? {};
  if (config.providerSessionId === providerSessionId) return;

  await db
    .update(sessions)
    .set({ config: { ...config, providerSessionId }, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, sessionId));

  events.emit(sessionChangedChannel, {
    sessionId,
    changes: { providerSessionId },
  });
}

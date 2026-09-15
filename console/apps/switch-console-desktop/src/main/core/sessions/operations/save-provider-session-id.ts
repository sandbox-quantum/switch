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
  await saveNativeSessionId(sessionId, providerSessionId);
}

/**
 * Record the provider's own id for a session's conversation, so a later launch
 * resumes it.
 *
 * Unvalidated, deliberately. The Droid path above checks the shape because that
 * id is scraped out of a hook payload and could be anything; a provider adapter
 * reports the id it just created, and refusing it here would silently cost the
 * session its resume.
 */
export async function saveNativeSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<void> {
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

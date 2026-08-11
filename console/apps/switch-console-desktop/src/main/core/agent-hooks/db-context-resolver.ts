import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { parsePtyId } from '@shared/core/pty/ptyId';
import type { ContextResolver } from './event-enricher';

/**
 * The local main process's hook context resolver: derives the session context
 * for a `ptyId` by parsing it and confirming the session exists in the
 * database.
 */
export const dbContextResolver: ContextResolver = async (ptyId) => {
  const parsed = parsePtyId(ptyId);
  if (!parsed) return null;

  const loaded = await loadSessionWithAgent(parsed.sessionId);
  if (!loaded) return null;

  return {
    sessionId: parsed.sessionId,
    providerId: parsed.providerId,
    ptyId,
  };
};

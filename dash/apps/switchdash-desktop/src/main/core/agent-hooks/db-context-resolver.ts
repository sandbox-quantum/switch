import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { parsePtyId } from '@shared/core/pty/ptyId';
import type { ContextResolver } from './event-enricher';

/**
 * The local main process's hook context resolver: derives the conversation
 * context for a `ptyId` by parsing it and loading the session (for its
 * project id) from the database.
 */
export const dbContextResolver: ContextResolver = async (ptyId) => {
  const parsed = parsePtyId(ptyId);
  if (!parsed) return null;

  const loaded = await loadSessionWithAgent(parsed.conversationId);
  if (!loaded) return null;

  return {
    conversationId: parsed.conversationId,
    sessionId: parsed.conversationId,
    projectId: loaded.projectId,
    providerId: parsed.providerId,
    ptyId,
  };
};

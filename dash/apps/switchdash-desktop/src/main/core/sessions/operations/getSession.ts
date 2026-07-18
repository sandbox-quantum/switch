import { type Session } from '@shared/core/sessions/sessions';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

export async function getSession(sessionId: string): Promise<Session | null> {
  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) return null;
  return mapSessionRowToSession(loaded.row, loaded.providerId);
}

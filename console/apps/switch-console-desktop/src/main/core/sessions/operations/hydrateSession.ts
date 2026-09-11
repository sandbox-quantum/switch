import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

export async function hydrateSession(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Session not found');
  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error('Session row not found');
  await agent.start(
    mapSessionRowToSession(loaded.row, loaded.providerId, loaded.name),
    undefined,
    true
  );
}

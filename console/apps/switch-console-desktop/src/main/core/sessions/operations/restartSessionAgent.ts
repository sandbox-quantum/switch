import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

export async function restartSessionAgent(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Reconnect this shared SDK session before restarting its host.');
  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error(`Session row not found for ${sessionId}`);
  await agent.restart(mapSessionRowToSession(loaded.row, loaded.providerId, loaded.name));
}

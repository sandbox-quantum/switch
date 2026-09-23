import { getAgentById } from '@main/core/agents/getAgentById';
import { locationWhereAgentRuns } from '@main/core/agents/observed-guard';
import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

export async function restartSessionAgent(sessionId: string): Promise<void> {
  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error(`Session row not found for ${sessionId}`);
  // The host of an observed agent's session is its owner's to restart
  // (CHOO-2893); this refuses with that reason rather than "reconnect first".
  const owner = await getAgentById(loaded.row.agentId);
  if (owner) await locationWhereAgentRuns(owner);
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Reconnect this shared SDK session before restarting its host.');
  await agent.restart(mapSessionRowToSession(loaded.row, loaded.providerId, loaded.name));
}

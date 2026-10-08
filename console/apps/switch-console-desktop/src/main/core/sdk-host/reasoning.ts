import { sharedSessionRoot } from '@switch-console/agent-providers';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { log } from '@main/lib/logger';
import { reasoningListSchema, type ReasoningList } from '@shared/core/sessions/reasoning';
import { isCloudAgent } from './cloud-control';
import { localSessionLinks } from './local-host';
import { sidecarControl } from './sidecar-control';

/** A managed agent run by an agents controller; its sessions are relayed through Switch. */
const CONTROLLER_AGENT_PREFIX = 'controller:';

/**
 * The reasoning a session's host still holds for `turnIds` (every buffered
 * turn when null), or null when there is none to show.
 *
 * Only a host on this machine or on the agent's SSH host is asked: reasoning
 * never travels through Switch, so a cloud or controller-run session has
 * none. A host or sidecar that predates reasoning, one that is not running,
 * or one that cannot be reached all read as none — this never raises, and
 * never starts or waits for a host.
 *
 * An SSH sidecar is not asked with the session request `askHost` sends: one
 * that predates reasoning closes the whole control connection on a request
 * type it cannot parse. `ControlClient.reasoning` sends a message such a
 * sidecar reads as a health ask instead, and its health answer fails the
 * parse below.
 */
export async function listReasoning(
  agentId: string,
  sessionId: string,
  turnIds: string[] | null
): Promise<ReasoningList | null> {
  if (isCloudAgent(agentId) || agentId.startsWith(CONTROLLER_AGENT_PREFIX)) return null;
  try {
    const agent = await getAgentById(agentId);
    if (!agent?.switchAgentId) return null;
    const answer = (await getAgentLocation(agent)).sshHost
      ? await (await sidecarControl(agentId)).reasoning(sessionId, turnIds)
      : await localSessionLinks.reasoning(sharedSessionRoot(sessionId), turnIds);
    if (answer === null) return null;
    const parsed = reasoningListSchema.safeParse(answer);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    log.warn('Could not read the session reasoning; showing none', {
      agentId,
      sessionId,
      error: String(error),
    });
    return null;
  }
}

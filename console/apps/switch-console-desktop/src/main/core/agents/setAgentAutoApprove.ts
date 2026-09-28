import { recordAutoApproveOnHost } from '@main/core/sdk-host/shared-watcher';
import {
  listAutoSessionAgentIds,
  listStoppedControllerAgentIds,
} from '@main/core/switch-rooms/auto-session-store';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { pushRemoteAutoApprove } from './remote-watcher';
import { updateAgent } from './updateAgent';

export type AgentAutoApproveParams = { agentId: string; enabled: boolean };

/**
 * Toggle an agent's per-agent bypass-permissions setting (CHOO-1664).
 *
 * Writes the agent row, then makes the change reach auto-started sessions:
 * - Local agents need nothing extra — the in-process auto-session watcher reads
 *   `agent.autoApprove` fresh each time it spawns a session.
 * - Remote agents bake the setting into the VM watcher's launch spec. When the
 *   watcher may start sessions (auto_session on, and nobody stopped it),
 *   re-ensure it so the spec file is rewritten with the new value; the running
 *   sidecar re-reads it live and applies it to the next auto-started session
 *   without a restart. Otherwise nothing re-ensures it now — a stopped watcher
 *   is not rewritten — but the saved spec is still updated: every other write
 *   of a remote watcher takes auto-approve from that spec, because other
 *   Consoles on the same account share it (CHOO-2893), so a value left only in
 *   this row would be put back by the next start.
 *
 * Reaching the host is allowed to throw: if the VM is unreachable the setting
 * cannot take effect, and the caller should surface that rather than pretend it
 * did. The row is left as it was, so it does not claim a change the host lacks.
 */
export async function setAgentAutoApprove(params: AgentAutoApproveParams): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);
  const setRow = async (autoApprove: boolean) => {
    if (!(await updateAgent({ agentId: agent.id, autoApprove }))) {
      throw new Error(`No agent with id ${params.agentId}`);
    }
  };
  if ((await getRemoteAgentLocation(agent)) === null) {
    await setRow(params.enabled);
    return;
  }
  // Every later write of the watcher takes auto-approve from the host, so the
  // row never holds a value the host does not: a change the host did not take
  // would be put back there, with only a log line to say so.
  const [spawning, stopped] = await Promise.all([
    listAutoSessionAgentIds(),
    listStoppedControllerAgentIds(),
  ]);
  if (!spawning.includes(agent.id) || stopped.includes(agent.id)) {
    await recordAutoApproveOnHost(agent.id, params.enabled);
    await setRow(params.enabled);
    return;
  }
  // The push writes the watcher from the row, so the row goes first — and back
  // if the push does not reach the host.
  await setRow(params.enabled);
  try {
    await pushRemoteAutoApprove(agent.id);
  } catch (error) {
    await setRow(agent.autoApprove);
    throw error;
  }
}

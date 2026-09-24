import { recordAutoApproveOnHost } from '@main/core/sdk-host/shared-watcher';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { locationWhereAgentRuns } from './observed-guard';
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
 *   agent's on-VM watcher is running (auto_session enabled), re-ensure the
 *   sidecar so the spec file is rewritten with the new value; the running sidecar
 *   re-reads it live and applies it to the next auto-started session without a
 *   restart. When auto_session is off there is no watcher to refresh, but the
 *   saved spec is still updated: every other write of a remote watcher takes
 *   auto-approve from that spec, because other Consoles on the same account
 *   share it (CHOO-2893), so a value left only in this row would be lost.
 *
 * The re-ensure is allowed to throw: if the VM is unreachable the setting cannot
 * take effect live, and the caller should surface that rather than pretend it did.
 */
export async function setAgentAutoApprove(params: AgentAutoApproveParams): Promise<void> {
  // Whether an observed agent's sessions approve on their own is decided where
  // they run, by its owner's Console (CHOO-2893).
  const existing = await getAgentById(params.agentId);
  if (!existing) throw new Error(`No agent with id ${params.agentId}`);
  await locationWhereAgentRuns(existing);
  const agent = await updateAgent({ agentId: params.agentId, autoApprove: params.enabled });
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);

  if ((await getRemoteAgentLocation(agent)) === null) return;
  if (!(await listAutoSessionAgentIds()).includes(agent.id)) {
    await recordAutoApproveOnHost(agent.id);
    return;
  }
  await pushRemoteAutoApprove(agent.id);
}

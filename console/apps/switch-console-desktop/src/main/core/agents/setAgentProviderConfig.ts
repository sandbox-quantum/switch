import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { getAgentLocation, getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';
import { removeAgentLaunchProfile } from './remove-launch-profile';
import { updateAgent } from './updateAgent';

export type AgentProviderConfigParams = {
  agentId: string;
  /** Null clears the specialization, putting the agent back on provider defaults. */
  config: AgentProviderConfig | null;
};

/**
 * Set an agent's per-agent provider config (Codex model / reasoning effort /
 * instructions) after creation.
 *
 * The value is folded into the agent's launch profile when a session starts, so
 * a change reaches the *next* session rather than any that is already running —
 * the profile is read by the CLI at spawn and there is no way to reload it under
 * a live process. Callers that want it applied now restart the session
 * (`sessions.restartAgent`).
 *
 * Two things have to happen beyond the row write for that to hold:
 * - Clearing the config removes the launch profile. With nothing to specialize
 *   the next launch passes no `--profile` at all, so the file would otherwise be
 *   left behind unreferenced — and would come back to life the moment the agent
 *   is specialized again under the same name and directory.
 * - A remote agent bakes the specialization into its on-VM watcher's launch
 *   spec, so the watcher is re-ensured to rewrite it; the running sidecar
 *   re-reads the spec and applies it to the next auto-started session. When
 *   auto_session is off there is no watcher to refresh and the next
 *   `ensureRemoteWatcher` picks the value up.
 *
 * The re-ensure is allowed to throw: if the VM is unreachable the change cannot
 * reach auto-started sessions, and the caller should surface that rather than
 * report a save that only half landed.
 */
export async function setAgentProviderConfig(params: AgentProviderConfigParams): Promise<void> {
  // Resolve the location before writing, not after. It is only needed to clear,
  // but a missing location row would otherwise throw with the change already
  // committed — telling the caller the save failed when it had not.
  const existing = await getAgentById(params.agentId);
  if (!existing) throw new Error(`No agent with id ${params.agentId}`);
  const location = params.config === null ? await getAgentLocation(existing) : null;

  const agent = await updateAgent({ agentId: params.agentId, providerConfig: params.config });
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);

  if (location) {
    await removeAgentLaunchProfile(agent, location, agent.name ?? agent.id);
  }

  if ((await getRemoteAgentLocation(agent)) === null) return;
  if (!(await listAutoSessionAgentIds()).includes(agent.id)) return;
  await ensureRemoteWatcher(agent.id);
}

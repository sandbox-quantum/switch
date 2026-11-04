import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { AgentStatusPanel } from './agent-status-panel';
import { useManagedAgentActions } from './use-managed-agent-actions';
import { useOnSharedCloudBox } from './use-managed-agents';

/**
 * Why the agent stopped, on its page (visibility V2). Hosted agents v2 only:
 * with `hosted_v2` off this draws nothing and runs none of the machine lookups
 * or actions below, so the agent's page is upstream's.
 */
export function AgentStatus({ agent }: { agent: ManagedAgentView }) {
  const v2 = useFeatureFlags(agent.serverId).hosted_v2;
  return v2 ? <AgentStatusOnV2 agent={agent} /> : null;
}

/** Shown only for a stopped agent on a v2 box, as the cards are. */
function AgentStatusOnV2({ agent }: { agent: ManagedAgentView }) {
  const onSharedBox = useOnSharedCloudBox(agent);
  const { busy, setDesiredState } = useManagedAgentActions(agent);
  if (!onSharedBox || !agent.stopReason || !agent.machine || !isCloudMachine(agent.machine)) {
    return null;
  }
  // Restart agent is turning it off and on again, as Your Agents does (B48).
  const restart = async () => {
    await setDesiredState('stopped');
    await setDesiredState('running');
  };
  return (
    <AgentStatusPanel
      reason={agent.stopReason}
      now={new Date()}
      onRestart={() => void restart()}
      restarting={busy}
    />
  );
}

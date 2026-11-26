import { AgentProfileActions as SharedAgentProfileActions } from '@switch-console/chat-ui/components/agent-profile-actions';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { useManagedAgentActions } from './use-managed-agent-actions';

/**
 * Turning an agent on or off, and moving it to another device, beside its
 * Connectors and Agent settings: they are about the agent, not the chat or
 * room open beside it, so they sit with the agent rather than in that ⋮ menu.
 */
export function AgentProfileActions({ agent }: { agent: ManagedAgentView }) {
  const { busy, setDesiredState } = useManagedAgentActions(agent);
  const showMoveModal = useShowModal('moveAgentModal');
  return (
    <SharedAgentProfileActions
      desiredState={agent.desiredState}
      busy={busy}
      onToggleState={() =>
        void setDesiredState(agent.desiredState === 'running' ? 'stopped' : 'running')
      }
      onMove={() => showMoveModal({ agent })}
    />
  );
}

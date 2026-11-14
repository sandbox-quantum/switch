import { ProfileButton } from '@switch-console/chat-ui/components/agent-page';
import { ArrowRightLeft, Power, PowerOff } from 'lucide-react';
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
  const running = agent.desiredState === 'running';
  return (
    <>
      <ProfileButton
        label={running ? 'Turn off agent' : 'Turn on agent'}
        icon={running ? PowerOff : Power}
        disabled={busy}
        onClick={() => void setDesiredState(running ? 'stopped' : 'running')}
      />
      <ProfileButton
        label="Move to another device…"
        icon={ArrowRightLeft}
        disabled={busy}
        onClick={() => showMoveModal({ agent })}
      />
    </>
  );
}

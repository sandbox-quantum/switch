import { ProviderStatusRow } from '@renderer/lib/components/provider-status-row';
import { useThisComputerReport } from '@renderer/lib/stores/use-this-computer-report';
import { SIGN_IN_UNCHECKED } from '@shared/core/managed-agents/managed-agents';
import type { AgentPayload } from '@shared/core/providers/agent-payload';
import { asAgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { RecheckThisComputer, ThisComputerProviderStatus } from './this-computer-provider-status';
import { installedHere, reportedProvider } from './this-computer-status';

export const AgentRow = ({ agent, onClick }: { agent: AgentPayload; onClick?: () => void }) => {
  const { data: report } = useThisComputerReport();
  const reported = reportedProvider(report, agent.id);
  return (
    <ProviderStatusRow
      providerId={agent.id}
      name={agent.name}
      installed={installedHere(reported, agent.status)}
      status={<ThisComputerProviderStatus providerId={asAgentProviderId(agent.id)} compact />}
      action={
        reported?.problem === SIGN_IN_UNCHECKED ? (
          <RecheckThisComputer providerName={agent.name} />
        ) : undefined
      }
      onClick={onClick}
    />
  );
};

import { ProviderStatusRow } from '@renderer/lib/components/provider-status-row';
import { useThisComputerReport } from '@renderer/lib/stores/use-this-computer-report';
import type { AgentPayload } from '@shared/core/providers/agent-payload';
import { asAgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { ThisComputerProviderStatus } from './this-computer-provider-status';
import { installedHere, reportedProvider } from './this-computer-status';

export const AgentRow = ({ agent, onClick }: { agent: AgentPayload; onClick?: () => void }) => {
  const { data: report } = useThisComputerReport();
  return (
    <ProviderStatusRow
      providerId={agent.id}
      name={agent.name}
      installed={installedHere(reportedProvider(report, agent.id), agent.status)}
      status={<ThisComputerProviderStatus providerId={asAgentProviderId(agent.id)} compact />}
      onClick={onClick}
    />
  );
};

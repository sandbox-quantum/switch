import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useThisComputerReport } from '@renderer/lib/stores/use-this-computer-report';
import type { AgentPayload } from '@shared/core/providers/agent-payload';
import { asAgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { InstalledBadge, UninstalledBadge } from './agent-status-badge';
import { ThisComputerProviderStatus } from './this-computer-provider-status';
import { installedHere, reportedProvider } from './this-computer-status';

export const AgentRow = ({ agent, onClick }: { agent: AgentPayload; onClick?: () => void }) => {
  const { data: report } = useThisComputerReport();
  const isInstalled = installedHere(reportedProvider(report, agent.id), agent.status);
  const isClickable = !!onClick;
  const Tag = isClickable ? 'button' : 'div';

  return (
    <Tag
      className={`group flex w-full items-center gap-3 rounded-lg p-3 hover:bg-background-1${isClickable ? ' cursor-pointer text-left' : ''}`}
      onClick={isClickable ? onClick : undefined}
    >
      <div className="flex size-6 items-center justify-center rounded-lg bg-background-1 p-1.5 group-hover:bg-background-2">
        <AgentIcon id={agent.id} size={16} />
      </div>
      <div className="flex w-full flex-col gap-0.5">
        <div className="flex w-full items-center justify-between">
          <span className="text-sm text-foreground">{agent.name}</span>
          <div className="flex items-center gap-1.5">
            {isInstalled ? <InstalledBadge /> : <UninstalledBadge />}
          </div>
        </div>
        <ThisComputerProviderStatus providerId={asAgentProviderId(agent.id)} compact />
      </div>
    </Tag>
  );
};

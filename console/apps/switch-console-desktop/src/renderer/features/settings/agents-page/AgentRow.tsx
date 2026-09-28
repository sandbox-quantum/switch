import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { ProviderConnectionStatus } from '@renderer/lib/components/provider-connection-status';
import type { AgentPayload } from '@shared/core/providers/agent-payload';
import { asAgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { InstalledBadge, UninstalledBadge } from './agent-status-badge';

export const AgentRow = ({ agent, onClick }: { agent: AgentPayload; onClick?: () => void }) => {
  const isInstalled = agent.status === 'available';
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
        <ProviderConnectionStatus
          providerId={asAgentProviderId(agent.id)}
          sshHost={null}
          dir=""
          compact
        />
      </div>
    </Tag>
  );
};

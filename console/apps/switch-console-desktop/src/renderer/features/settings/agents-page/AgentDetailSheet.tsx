import { observer } from 'mobx-react-lite';
import { useAgentSettings } from '@renderer/lib/stores/use-agent-settings';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useThisComputerReport } from '@renderer/lib/stores/use-this-computer-report';
import { Sheet, SheetContent, SheetHeader } from '@renderer/lib/ui/sheet';
import { AgentSheetHeaderSection } from './AgentSheetHeaderSection';
import { InstalledAgentContent } from './InstalledAgentContent';
import { ProviderSetup } from './ProviderSetup';
import { installedHere, reportedProvider } from './this-computer-status';

interface AgentDetailSheetProps {
  agentId: string | null;
  onClose: () => void;
}

const AgentDetailSheetContent = observer(function AgentDetailSheetContent({
  agentId,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const { data: agents } = useAgents();
  const agentPayload = agents?.find((a) => a.id === agentId);

  const { value: storedConfig, isOverridden, isLoading, update, reset } = useAgentSettings(agentId);

  const { data: report } = useThisComputerReport();
  const reported = reportedProvider(report, agentId);
  const isInstalled = installedHere(reported, agentPayload?.status);

  return (
    <>
      <SheetHeader label={isInstalled ? 'Agent Settings' : 'Install Agent'} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="px-4">
          {agentPayload && (
            <div className="space-y-6">
              <AgentSheetHeaderSection agent={agentPayload} />
              <ProviderSetup providerId={agentId} />
            </div>
          )}
        </div>
        {agentPayload && isInstalled && (
          <InstalledAgentContent
            storedConfig={storedConfig}
            isOverridden={isOverridden}
            isLoading={isLoading}
            update={update}
            reset={reset}
          />
        )}
      </div>
    </>
  );
});

export function AgentDetailSheet({ agentId, onClose }: AgentDetailSheetProps) {
  return (
    <Sheet open={agentId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0">
        {agentId && <AgentDetailSheetContent agentId={agentId} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

import { observer } from 'mobx-react-lite';
import { useAgentSettings } from '@renderer/lib/stores/use-agent-settings';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useThisComputerReport } from '@renderer/lib/stores/use-this-computer-report';
import { Field } from '@renderer/lib/ui/field';
import { Label } from '@renderer/lib/ui/label';
import { Sheet, SheetContent, SheetHeader } from '@renderer/lib/ui/sheet';
import { asAgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { AgentSheetHeaderSection } from './AgentSheetHeaderSection';
import { InstalledAgentContent } from './InstalledAgentContent';
import { InstallSection } from './InstallSection';
import { ThisComputerProviderStatus } from './this-computer-provider-status';
import { installedHere, installSourcesDiffer, reportedProvider } from './this-computer-status';

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
  const sourcesDiffer = installSourcesDiffer(reported, agentPayload?.status);

  return (
    <>
      <SheetHeader label={isInstalled ? 'Agent Settings' : 'Install Agent'} />
      <div className="overflow-y-auto px-4">
        {agentPayload && (
          <div className="space-y-6">
            <AgentSheetHeaderSection agent={agentPayload} />
            <ThisComputerProviderStatus providerId={asAgentProviderId(agentId)} />
            <Field>
              <Label>Installation</Label>
              {sourcesDiffer && (
                <p className="text-xs text-foreground-muted">
                  What Console finds on its own PATH, used to install and update. The status above
                  is what this computer’s agents controller reported to Switch, and it looks in
                  places Console may not.
                </p>
              )}
              <InstallSection
                agentId={agentId}
                agentPayload={agentPayload}
                installOptions={agentPayload.installOptions}
                hideOverrideOptions={!isInstalled}
              />
            </Field>
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

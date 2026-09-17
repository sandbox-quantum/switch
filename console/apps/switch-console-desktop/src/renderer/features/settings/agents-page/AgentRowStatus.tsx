import { useSwitchSetup } from '@renderer/lib/stores/use-switch-setup';
import {
  ConnectorUpdateBadge,
  InstalledBadge,
  SwitchSetupRequiredBadge,
  UninstalledBadge,
} from './agent-status-badge';

/** Report CLI installation separately from required Switch connector setup. */
export function AgentRowStatus({
  agentId,
  supportsSwitch,
  cliInstalled,
}: {
  agentId: string;
  supportsSwitch: boolean;
  cliInstalled: boolean;
}) {
  if (!supportsSwitch) {
    return cliInstalled ? <InstalledBadge /> : <UninstalledBadge />;
  }
  return <SwitchAwareStatus agentId={agentId} cliInstalled={cliInstalled} />;
}

function SwitchAwareStatus({ agentId, cliInstalled }: { agentId: string; cliInstalled: boolean }) {
  const { status, isLoading } = useSwitchSetup(agentId);

  // Not on the machine yet — nothing else matters.
  if (!cliInstalled) return <UninstalledBadge />;

  // CLI installed; refine by connector state. While the connector status is
  // still loading (or unexpectedly unsupported), fall back to plain Installed.
  if (isLoading || !status?.supported) return <InstalledBadge />;
  if (!status.installed)
    return (
      <>
        <InstalledBadge />
        <SwitchSetupRequiredBadge />
      </>
    );

  return (
    <>
      {status.updateAvailable && <ConnectorUpdateBadge />}
      <InstalledBadge />
    </>
  );
}

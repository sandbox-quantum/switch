import { useSwitchSetup } from '@renderer/lib/stores/use-switch-setup';
import {
  InstalledBadge,
  SwitchSetupRequiredBadge,
  UninstalledBadge,
  UpdateAvailableBadge,
} from './agent-status-badge';

/**
 * Combined usability status for an agent row.
 *
 * For agent types that need a Switch connector (e.g. Claude Code), "Installed"
 * means the agent is actually usable in Switch — the CLI is on the machine AND
 * the connector is set up. The intermediate "Switch setup required" state makes
 * clear that an installed CLI is not yet usable on its own. Agent types with no
 * Switch setup keep the plain installed/not-installed status.
 */
export function AgentRowStatus({
  agentId,
  supportsSwitch,
  cliInstalled,
  cliUpdateAvailable,
}: {
  agentId: string;
  supportsSwitch: boolean;
  cliInstalled: boolean;
  cliUpdateAvailable: boolean;
}) {
  if (!supportsSwitch) {
    return (
      <>
        {cliUpdateAvailable && <UpdateAvailableBadge />}
        {cliInstalled ? <InstalledBadge /> : <UninstalledBadge />}
      </>
    );
  }
  return (
    <SwitchAwareStatus
      agentId={agentId}
      cliInstalled={cliInstalled}
      cliUpdateAvailable={cliUpdateAvailable}
    />
  );
}

function SwitchAwareStatus({
  agentId,
  cliInstalled,
  cliUpdateAvailable,
}: {
  agentId: string;
  cliInstalled: boolean;
  cliUpdateAvailable: boolean;
}) {
  const { status, isLoading } = useSwitchSetup(agentId);
  const connectorUpdateAvailable = !!status?.installed && !!status.updateAvailable;

  // Not on the machine yet — nothing else matters.
  if (!cliInstalled) return <UninstalledBadge />;

  // CLI installed; refine by connector state. While the connector status is
  // still loading (or unexpectedly unsupported), fall back to plain Installed.
  const statusBadge =
    isLoading || !status?.supported ? (
      <InstalledBadge />
    ) : status.installed ? (
      <InstalledBadge />
    ) : (
      <SwitchSetupRequiredBadge />
    );

  return (
    <>
      {(cliUpdateAvailable || connectorUpdateAvailable) && <UpdateAvailableBadge />}
      {statusBadge}
    </>
  );
}

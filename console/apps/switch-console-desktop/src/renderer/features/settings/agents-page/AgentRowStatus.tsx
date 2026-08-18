import { useSwitchSetup } from '@renderer/lib/stores/use-switch-setup';
import {
  ConnectorUpdateBadge,
  InstalledBadge,
  SwitchSetupRequiredBadge,
  UninstalledBadge,
} from './agent-status-badge';

/**
 * Combined usability status for an agent row.
 *
 * For agent types that need a Switch connector (e.g. Claude Code), "Installed"
 * means the agent is actually usable in Switch — the CLI is on the machine AND
 * the connector is set up. The intermediate "Switch setup required" state makes
 * clear that an installed CLI is not yet usable on its own. Agent types with no
 * Switch setup keep the plain installed/not-installed status.
 *
 * A newer version of the agent's own CLI is deliberately not reported here. It
 * changes nothing about whether the agent works in Switch, and shown beside the
 * name it read as a fault on an agent that was fine — the list answers "can I
 * use this", and an optional upgrade is not an answer to that. It stays on the
 * agent's own page, where someone has gone looking. The connector is the
 * exception: it is ours, and a stale one is worth acting on.
 */
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
  if (!status.installed) return <SwitchSetupRequiredBadge />;

  return (
    <>
      {status.updateAvailable && <ConnectorUpdateBadge />}
      <InstalledBadge />
    </>
  );
}

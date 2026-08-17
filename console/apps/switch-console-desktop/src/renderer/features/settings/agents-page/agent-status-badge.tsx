import { StatusBadge } from '@renderer/lib/ui/status-badge';

export function InstalledBadge() {
  return <StatusBadge tone="success">Installed</StatusBadge>;
}

export function UninstalledBadge() {
  return <StatusBadge tone="neutral">Not installed</StatusBadge>;
}

/** Agent CLI is on the machine, but the Switch connector still needs setup. */
export function SwitchSetupRequiredBadge() {
  return <StatusBadge tone="warning">Switch setup required</StatusBadge>;
}

/**
 * The Switch connector is behind the version this build ships.
 *
 * Named for the connector rather than "Update available": the agent's own CLI
 * can also be out of date, and that is between the user and their CLI. This one
 * is ours, it is what lets the agent speak to Switch at all, and it is worth
 * acting on — so it says which thing it means.
 */
export function ConnectorUpdateBadge() {
  return <StatusBadge tone="warning">Connector update</StatusBadge>;
}

export function RecommendedBadge() {
  return (
    <StatusBadge tone="neutral" className="text-[10px]">
      Recommended
    </StatusBadge>
  );
}

export function UsedBadge() {
  return (
    <StatusBadge tone="info" className="text-[10px]">
      Used
    </StatusBadge>
  );
}

export function InstallingBadge() {
  return <StatusBadge tone="info">Installing…</StatusBadge>;
}

export function UpdatingBadge() {
  return <StatusBadge tone="info">Updating…</StatusBadge>;
}

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

export function UpdateAvailableBadge() {
  return <StatusBadge tone="warning">Update available</StatusBadge>;
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

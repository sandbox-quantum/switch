import { Cloud, Laptop, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  useManagedAgents,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { RemoteHostsSettingsPage } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { PageHeader } from '@renderer/lib/components/page-header';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { Spinner } from '@renderer/lib/ui/spinner';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import { type DeviceRow, type DeviceType, deviceRows } from './devices';
import { settingsServer } from './settings-server';

const TYPE: Record<DeviceType, { label: string; icon: typeof Laptop }> = {
  computer: { label: 'Computer', icon: Laptop },
  cloud: { label: 'Cloud', icon: Cloud },
  ssh: { label: 'Remote SSH', icon: Server },
};

const STATE_TONE: Record<DeviceRow['state'], StatusTone> = {
  online: 'success',
  offline: 'neutral',
  unknown: 'neutral',
  revoked: 'danger',
};

/**
 * The computers your agents can run on. The machines Switch knows are yours
 * come from the server, where agent management runs; the SSH hosts this
 * Console reaches are this computer's own list, so they show with no server
 * at all.
 */
export const DevicesSettingsPage = observer(function DevicesSettingsPage() {
  const { server, user } = settingsServer();
  const agentManagement = useFeatureFlags(server?.id ?? null).agent_management;
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="Your devices"
        description="The devices you own and the agents that can run on them."
      />
      {server && user && agentManagement && <MachinesTable serverId={server.id} />}
      <RemoteHostsSettingsPage embedded />
    </div>
  );
});

const MachinesTable = observer(function MachinesTable({ serverId }: { serverId: string }) {
  const machines = useOwnedMachines(serverId);
  const agents = useManagedAgents(serverId);
  if (machines.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner /> Loading devices…
      </div>
    );
  }
  if (machines.isError) {
    return <p className="text-sm text-destructive">Could not load your devices.</p>;
  }
  const rows = deviceRows(machines.data ?? [], agents.data ?? []);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-foreground-muted">No device is running agents for you yet.</p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-foreground-muted">
            <th className="px-3 py-2 font-normal">Device</th>
            <th className="px-3 py-2 font-normal">State</th>
            <th className="px-3 py-2 font-normal">Type</th>
            <th className="px-3 py-2 font-normal">Agents</th>
            <th className="px-3 py-2 font-normal">Platform</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const type = TYPE[row.type];
            return (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">
                  <div className="text-foreground">{row.name}</div>
                  {row.detail && <div className="text-xs text-foreground-muted">{row.detail}</div>}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge tone={STATE_TONE[row.state]}>{row.state}</StatusBadge>
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <type.icon className="size-3.5 text-foreground-muted" />
                    {type.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-foreground tabular-nums">{row.agents}</td>
                <td className="px-3 py-2 text-foreground-muted">{row.platform ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

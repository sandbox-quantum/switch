import { useQuery } from '@tanstack/react-query';
import { Cloud, Monitor, Server } from 'lucide-react';
import { useMemo } from 'react';
import {
  machineIdOf,
  machineLabel,
  machineRunLocation,
  machineRunLocations,
} from '@renderer/features/locations/components/add-agent-modal/server-run-locations';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

export const LOCAL_RUN_LOCATION = 'local';

/**
 * The SSH hosts an agent for `serverId` may run on. A server the Console
 * manages is reachable only from certain machines: one managed on a host is
 * reachable from this computer and from that host, one managed locally from
 * this computer only. A server the Console does not manage has no restriction.
 */
export function useAllowedHosts(serverId: string | null) {
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const kind = server?.managementKind ?? null;
  const host = server?.sshHost ?? null;
  return useMemo(
    () =>
      (remoteHosts ?? []).filter((h) =>
        kind === 'remote' ? h.sshHost === host : kind !== 'local'
      ),
    [remoteHosts, kind, host]
  );
}

export function runLocationLabel(
  value: string,
  hosts: readonly { sshHost: string; name: string }[]
): string {
  if (value === LOCAL_RUN_LOCATION) return 'This computer';
  return hosts.find((h) => h.sshHost === value)?.name ?? value;
}

export function RunLocationSelect({
  value,
  onChange,
  hosts,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  hosts: readonly { sshHost: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v ?? LOCAL_RUN_LOCATION)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full" aria-label="Run location">
        <SelectValue>
          {value === LOCAL_RUN_LOCATION ? (
            <Monitor className="size-4 text-foreground-muted" />
          ) : (
            <Server className="size-4 text-foreground-muted" />
          )}
          <span className="truncate">{runLocationLabel(value, hosts)}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LOCAL_RUN_LOCATION}>
          <Monitor className="size-4 text-foreground-muted" />
          <span className="flex-1">This computer</span>
          <span className="text-xs text-foreground-muted">local</span>
        </SelectItem>
        {hosts.map((h) => (
          <SelectItem key={h.sshHost} value={h.sshHost}>
            <Server className="size-4 text-foreground-muted" />
            <span className="flex-1 truncate">{h.name}</span>
            <span className="text-xs text-foreground-muted">ssh</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The value a `machine` param holds for one of the owner's machines: its id.
 * Listed as the New agent modal lists them: this computer first, as "This
 * computer"; offline machines shown but not pickable; the Switch cloud machine
 * only while it is online.
 */
export function MachineSelect({
  value,
  onChange,
  machines,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The owner's machines on the server; null when it does not run agent management. */
  machines: readonly OwnedMachine[] | null;
  disabled?: boolean;
}) {
  if (machines === null) {
    return (
      <p className="text-xs text-foreground-muted">
        This server does not run agent management, so there is no machine to choose.
      </p>
    );
  }
  const options = machineRunLocations([...machines]);
  const chosen = machines.find((m) => m.id === value || m.name === value) ?? null;
  const Icon = ({ kind }: { kind: 'monitor' | 'server' | 'cloud' }) =>
    kind === 'monitor' ? (
      <Monitor className="size-4 text-foreground-muted" />
    ) : kind === 'cloud' ? (
      <Cloud className="size-4 text-foreground-muted" />
    ) : (
      <Server className="size-4 text-foreground-muted" />
    );
  const selected = chosen
    ? options.find((o) => o.value === machineRunLocation(chosen.id))
    : undefined;
  return (
    <Select
      value={chosen ? machineRunLocation(chosen.id) : ''}
      onValueChange={(v) => onChange(v ? (machineIdOf(v) ?? '') : '')}
      disabled={disabled}
    >
      <SelectTrigger className="w-full" aria-label="Machine">
        <SelectValue>
          <Icon kind={selected?.icon ?? 'server'} />
          <span className="truncate">
            {selected
              ? selected.label
              : chosen
                ? machineLabel(chosen)
                : value || 'Choose a machine'}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            <Icon kind={o.icon} />
            <span className="flex-1 truncate">{o.label}</span>
            <span className="text-xs text-foreground-muted">{o.tag}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

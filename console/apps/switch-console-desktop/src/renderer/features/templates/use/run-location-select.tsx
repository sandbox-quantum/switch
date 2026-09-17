import { useQuery } from '@tanstack/react-query';
import { Monitor, Server } from 'lucide-react';
import { useMemo } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';

/** The select value for running on this computer rather than on an SSH host. */
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

/** A select between this computer and the onboarded SSH hosts. */
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

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

/** The `value` meaning "run on this machine" rather than on a host. */
export const LOCAL_RUN_LOCATION = 'local';

/**
 * The hosts an agent for `serverId` may run on. A managed server is only
 * reachable from certain places: a remote-managed one from this computer or
 * its own host, a local-managed one from this computer only. An external
 * server is unconstrained.
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

/** This computer, or one of the onboarded hosts, as a select. */
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

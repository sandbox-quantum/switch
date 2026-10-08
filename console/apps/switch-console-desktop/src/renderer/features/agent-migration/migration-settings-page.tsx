import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, Monitor, RefreshCw, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import type { MigrationMachine } from '@shared/core/agent-migration/agent-migration';
import { type MigrationTone, migrationMachineState, sortMachines } from './migration-presentation';

const TONE: Record<MigrationTone, StatusTone> = {
  neutral: 'neutral',
  busy: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'danger',
};

const BAR: Record<MigrationTone, string> = {
  neutral: 'bg-foreground-muted',
  busy: 'bg-foreground-info',
  ok: 'bg-foreground-success',
  warn: 'bg-foreground-warning',
  error: 'bg-foreground-destructive',
};

const OVERVIEW_KEY = ['agent-migration-overview'];

/**
 * Where the automatic move of this Console's agents onto managed machines
 * stands: one row per machine and server, with a counter, and what keeps any
 * agent from moving. Nothing here moves agents: Console does that by itself.
 */
export const MigrationSettingsPage = observer(function MigrationSettingsPage() {
  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => rpc.agentMigration.getOverview(),
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 10_000),
  });
  const runNow = useMutation({
    mutationFn: () => rpc.agentMigration.runNow(),
    onSettled: () => overview.refetch(),
  });
  const serverName = (serverId: string) =>
    switchServersStore.servers.find((server) => server.id === serverId)?.name ?? serverId;
  const data = overview.data;
  const running = runNow.isPending || data?.running === true;

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        sticky
        title="Managed agents"
        description="Console moves each of your agents onto a managed machine by itself, on this computer and on your SSH hosts, so Switch runs them. This shows how far that has got."
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-foreground-muted">
          {running ? (
            'Checking now…'
          ) : data?.lastPassAt ? (
            <>
              Last checked <RelativeTime value={data.lastPassAt} ago />. Checked again every minute.
            </>
          ) : (
            'Not checked yet.'
          )}
        </p>
        <Button variant="outline" size="sm" disabled={running} onClick={() => runNow.mutate()}>
          <RefreshCw className={cn('size-4', running && 'animate-spin')} /> Check now
        </Button>
      </div>
      {overview.error && (
        <p className="text-xs text-foreground-error">
          {failureText(overview.error, 'Could not read where the move stands.')}
        </p>
      )}
      {data && data.machines.length === 0 && (
        <p className="text-sm text-foreground-muted">
          No agent of yours is on a server with agent management.
        </p>
      )}
      {data && data.machines.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {sortMachines(data.machines).map((machine) => (
            <MachineRow
              key={`${machine.sshHost ?? ''}:${machine.serverId}`}
              machine={machine}
              serverName={serverName(machine.serverId)}
            />
          ))}
        </ul>
      )}
      {data && (data.leftAlone > 0 || data.unasked > 0) && (
        <div className="space-y-1 text-xs text-foreground-muted">
          {data.leftAlone > 0 && (
            <p>
              {data.leftAlone} {data.leftAlone === 1 ? 'agent stays' : 'agents stay'} in Console:
              someone else owns them, or their server has no agent management.
            </p>
          )}
          {data.unasked > 0 && (
            <p>
              Switch could not be asked about {data.unasked}{' '}
              {data.unasked === 1 ? 'agent' : 'agents'}: the server is stopped or unreachable, or no
              longer knows the agent. Tried again later.
            </p>
          )}
        </div>
      )}
    </div>
  );
});

function MachineRow({ machine, serverName }: { machine: MigrationMachine; serverName: string }) {
  const state = migrationMachineState(machine);
  const Icon = machine.sshHost === null ? Monitor : Server;
  const share = machine.total ? (machine.moved / machine.total) * 100 : 0;
  const name = machine.sshHost ?? 'This computer';
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {name}
          <span className="text-foreground-muted"> · {serverName}</span>
        </span>
        <span className="shrink-0 text-xs text-foreground-muted tabular-nums">
          {machine.moved}/{machine.total}
        </span>
        {state.tone === 'ok' ? (
          <CircleCheck className="size-4 shrink-0 text-foreground-success" aria-label="Done" />
        ) : (
          <StatusBadge tone={TONE[state.tone]} className="shrink-0">
            {state.label}
          </StatusBadge>
        )}
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={`${name} for ${serverName}: ${machine.moved} of ${machine.total} moved`}
        aria-valuemin={0}
        aria-valuemax={machine.total}
        aria-valuenow={machine.moved}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            BAR[state.tone],
            state.tone === 'busy' && 'animate-pulse'
          )}
          style={{ width: `${share}%` }}
        />
      </div>
      {state.note && (
        <p className="pl-6.5 text-xs break-words text-foreground-muted">{state.note}</p>
      )}
      {!state.note && machine.problems.length > 1 && (
        <ul className="space-y-0.5 pl-6.5 text-xs text-foreground-muted">
          {machine.problems.map((problem) => (
            <li key={problem.agentId} className="break-words">
              <span className="text-foreground">{problem.name}</span>: {problem.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

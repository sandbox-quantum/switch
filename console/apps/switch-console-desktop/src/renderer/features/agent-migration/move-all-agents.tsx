import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Monitor, Server } from 'lucide-react';
import { useState } from 'react';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';
import { MOVE_RULE, type MoveAllMachine } from '@shared/core/agent-migration/agent-migration';
import {
  type MigrationTone,
  moveAllMachineState,
  moveAllOutcome,
  moveAllState,
} from './agent-migration-presentation';

const TONE: Record<MigrationTone, StatusTone> = {
  neutral: 'neutral',
  busy: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'danger',
};

const BAR: Record<MigrationTone, string> = {
  neutral: 'bg-foreground-info',
  busy: 'bg-foreground-info',
  ok: 'bg-foreground-success',
  warn: 'bg-foreground-warning',
  error: 'bg-foreground-destructive',
};

/** How often progress is read again: every 2 s while agents move, so the counters climb as they do. */
const IDLE_REFRESH_MS = 10_000;
const MOVING_REFRESH_MS = 2_000;

/**
 * Moving every agent this Console runs for a workspace onto managed machines
 * at once, and how far that has got: one row per machine, this computer and
 * each SSH host, with a counter, rather than one per agent. Each agent can
 * still be moved on its own page.
 */
export function MoveAllAgents({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const scope = { serverId, workspaceId };
  const [outcome, setOutcome] = useState<string[] | null>(null);
  const settle = (lines: string[]) => {
    setOutcome(lines);
    void queryClient.invalidateQueries({ queryKey: ['agent-migration'] });
    void queryClient.invalidateQueries({ queryKey: ['embedded-controller', serverId] });
    void queryClient.invalidateQueries({ queryKey: ['host-controller'] });
  };
  const moveAll = useMutation({
    mutationFn: () => rpc.agentMigration.moveAllInWorkspace(scope),
    onMutate: () => setOutcome(null),
    onSuccess: (result) => settle(moveAllOutcome(result, 'Moved')),
  });
  const bringBack = useMutation({
    mutationFn: () => rpc.agentMigration.stopManagingAllInWorkspace(scope),
    onMutate: () => setOutcome(null),
    onSuccess: (result) => settle(moveAllOutcome(result, 'Brought back')),
  });
  const working = moveAll.isPending || bringBack.isPending;
  const progress = useQuery({
    queryKey: ['agent-migration', 'workspace', serverId, workspaceId],
    queryFn: () => rpc.agentMigration.moveAllProgressInWorkspace(scope),
    refetchInterval: working ? MOVING_REFRESH_MS : IDLE_REFRESH_MS,
  });
  const failure = moveAll.error ?? bringBack.error ?? progress.error;
  const machines = progress.data?.machines ?? [];
  const overall = progress.data ? moveAllState(progress.data) : null;
  const everyoneMoved = overall !== null && overall.managed === overall.total;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-sm text-foreground">
            Move all agents to managed
            <InfoTooltip label="What moving does" content={MOVE_RULE} />
          </p>
          <p className="text-xs text-foreground-muted">
            Every agent this Console runs for this workspace, on this computer and on your SSH
            hosts. A host that is not a machine yet is set up first.
          </p>
        </div>
        {overall && (
          <div className="flex shrink-0 items-center gap-2">
            {overall.total > 0 && (
              <span className="text-xs text-foreground-muted tabular-nums">
                {overall.managed}/{overall.total}
              </span>
            )}
            <StatusBadge tone={TONE[overall.tone]}>{overall.label}</StatusBadge>
          </div>
        )}
      </div>

      {machines.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {machines.map((machine) => (
            <MachineRow key={machine.name} machine={machine} />
          ))}
        </ul>
      )}
      {!progress.data && !progress.error && (
        <p className="text-xs text-foreground-muted">Loading…</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={working || !progress.data || everyoneMoved}
          onClick={() => moveAll.mutate()}
        >
          {moveAll.isPending ? 'Moving…' : 'Move all'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={working || !overall?.managed}
          onClick={() => bringBack.mutate()}
        >
          {bringBack.isPending ? 'Bringing back…' : 'Bring all back'}
        </Button>
        {outcome && <span className="min-w-0 text-xs text-foreground-muted">{outcome[0]}</span>}
      </div>
      {outcome && outcome.length > 1 && (
        <ul className="space-y-0.5 text-xs text-foreground-error">
          {outcome.slice(1).map((line) => (
            <li key={line} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p className="text-xs text-foreground-error">
          {failureText(failure, 'That did not work.')}
        </p>
      )}
    </div>
  );
}

function MachineRow({ machine }: { machine: MoveAllMachine }) {
  const state = moveAllMachineState(machine);
  const Icon = machine.kind === 'this-computer' ? Monitor : Server;
  const share = machine.total ? (machine.managed / machine.total) * 100 : 0;
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{machine.name}</span>
        <span className="shrink-0 text-xs text-foreground-muted tabular-nums">
          {machine.managed}/{machine.total}
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
        aria-label={`${machine.name}: ${machine.managed} of ${machine.total} moved`}
        aria-valuemin={0}
        aria-valuemax={machine.total}
        aria-valuenow={machine.managed}
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
        <p className="truncate pl-6.5 text-xs text-foreground-muted" title={state.note}>
          {state.note}
        </p>
      )}
    </li>
  );
}

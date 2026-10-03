import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Computer, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { moveAllSummary } from '@renderer/features/agent-migration/agent-migration-presentation';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import { Switch } from '@renderer/lib/ui/switch';
import { IDLE_RULE } from '@shared/core/agent-migration/agent-migration';
import type { EmbeddedControllerOverview } from '@shared/core/embedded-controller/embedded-controller';
import { embeddedControllerStateChannel } from '@shared/events/embeddedControllerEvents';
import { switchServersStore } from './switch-servers-store';
import {
  agentActual,
  canStartAgain,
  machineStatus,
  type MachineStatusTone,
  toggleBlocker,
  toggleChecked,
} from './this-computer-machine';

/** How often the card re-reads the server while it is on screen. */
const REFRESH_MS = 10_000;

const TONE: Record<MachineStatusTone, StatusTone> = {
  neutral: 'neutral',
  busy: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'danger',
};

const card = 'rounded-lg border border-border bg-card p-4';

function overviewKey(serverId: string): readonly unknown[] {
  return ['embedded-controller', serverId];
}

/**
 * "This computer as a machine": whether this Console runs the managed agents
 * the server places on this computer, how that is going, and which agents
 * they are. Agents created in Console itself are not affected either way.
 */
export const ThisComputerMachineCard = observer(function ThisComputerMachineCard({
  serverId,
  signedIn,
}: {
  serverId: string;
  signedIn: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const server = switchServersStore.servers.find((candidate) => candidate.id === serverId);
  const [confirmingOff, setConfirmingOff] = useState(false);

  const overviewQuery = useQuery({
    queryKey: [...overviewKey(serverId), workspaceId],
    queryFn: () => rpc.embeddedController.getOverview({ serverId, workspaceId }),
    refetchInterval: REFRESH_MS,
  });

  useEffect(
    () =>
      events.on(embeddedControllerStateChannel, (event) => {
        if (event.serverId !== serverId) return;
        void queryClient.invalidateQueries({ queryKey: overviewKey(serverId) });
      }),
    [queryClient, serverId]
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: overviewKey(serverId) });
  const enable = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error('Open a workspace on this server first.');
      return rpc.embeddedController.enable({ serverId, workspaceId });
    },
    onSettled: refresh,
  });
  const disable = useMutation({
    mutationFn: () => rpc.embeddedController.disable(serverId),
    onSettled: refresh,
  });
  const startAgain = useMutation({
    mutationFn: () => rpc.embeddedController.restart(serverId),
    onSettled: refresh,
  });
  const dismiss = useMutation({
    mutationFn: () => rpc.embeddedController.dismissRemoved(serverId),
    onSettled: refresh,
  });

  const overview = overviewQuery.data;
  // Nothing to say on a server this computer has nothing to do with and is not
  // signed in to: the sign-in form is the page's subject then.
  if (!overview) {
    if (!signedIn) return null;
    return (
      <section className={card}>
        <Heading />
        <p className="mt-2 text-xs text-foreground-muted">
          {overviewQuery.error
            ? failureText(overviewQuery.error, 'Could not read this computer’s state.')
            : 'Loading…'}
        </p>
      </section>
    );
  }
  if (!signedIn && !overview.enrollment && overview.phase.kind === 'off') return null;

  const status = machineStatus(overview);
  const blocker = toggleBlocker(overview);
  const checked = toggleChecked(overview);
  const failure = enable.error ?? disable.error ?? startAgain.error ?? dismiss.error;

  return (
    <section className={`${card} space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <Heading />
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={TONE[status.tone]}>{status.label}</StatusBadge>
          <Switch
            aria-label="Run managed agents on this computer"
            checked={checked}
            disabled={blocker !== null}
            onCheckedChange={(next) => {
              enable.reset();
              disable.reset();
              if (next) enable.mutate();
              else setConfirmingOff(true);
            }}
          />
        </div>
      </div>

      {blocker && blocker !== 'Working…' && (
        <p className="text-xs text-foreground-muted">{blocker}</p>
      )}
      {status.detail && (
        <p
          className={
            status.tone === 'error'
              ? 'text-xs text-foreground-error'
              : 'text-xs text-foreground-muted'
          }
        >
          {status.detail}
        </p>
      )}
      {failure && (
        <p className="text-xs text-foreground-error">
          {failureText(failure, 'That did not work.')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canStartAgain(overview) && (
          <Button
            variant="outline"
            size="sm"
            disabled={startAgain.isPending}
            onClick={() => startAgain.mutate()}
          >
            <RefreshCw className="size-4" />
            Start again
          </Button>
        )}
        {overview.phase.kind === 'removed' && (
          <Button
            variant="outline"
            size="sm"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            Dismiss
          </Button>
        )}
        {server && (overview.enrollment || overview.remote?.kind === 'ok') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void rpc.switchServers.openGatewayPage({
                serverId,
                url: `${server.gatewayUrl.replace(/\/+$/, '')}/machines`,
              })
            }
          >
            <ExternalLink className="size-4" />
            Machines
          </Button>
        )}
      </div>

      {overview.enrollment && <PlacedAgents overview={overview} />}
      {overview.enrollment && overview.phase.kind === 'running' && (
        <ConsoleAgentsHere serverId={serverId} />
      )}

      <Dialog open={confirmingOff} onOpenChange={setConfirmingOff}>
        <DialogContent>
          <DialogHeader>
            <TriangleAlert className="size-4 text-amber-500" />
            <DialogTitle>Stop running managed agents on this computer?</DialogTitle>
          </DialogHeader>
          <DialogContentArea>
            <DialogDescription>
              This removes {overview.enrollment?.name ?? 'this computer'} from Switch as a machine
              and stops the managed agents placed on it. They stay defined in Switch, and can be
              moved to another machine. Agents you created in this Console are not affected.
            </DialogDescription>
          </DialogContentArea>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmingOff(false);
                disable.mutate();
              }}
            >
              Remove this computer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
});

function Heading() {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Computer className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">This computer as a machine</h3>
        <p className="text-xs text-foreground-muted">
          Run managed agents on this computer: Switch can place agents here, and this Console runs
          them while it is open.
        </p>
      </div>
    </div>
  );
}

function PlacedAgents({ overview }: { overview: EmbeddedControllerOverview }) {
  const remote = overview.remote;
  if (!remote || remote.kind !== 'ok') return null;
  if (remote.agents.length === 0)
    return (
      <p className="text-xs text-foreground-muted">
        No managed agents are placed on this computer yet. Place one from the Machines page.
      </p>
    );
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {remote.agents.map((agent) => {
        const actual = agentActual(agent);
        return (
          <li key={agent.agentId} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{agent.displayName ?? agent.name}</p>
              <p className="truncate text-xs text-foreground-muted">
                {agent.provider} · wanted {agent.desiredState}
                {agent.actual?.detail ? ` · ${agent.actual.detail}` : ''}
              </p>
            </div>
            <StatusBadge tone={TONE[actual.tone]} className="shrink-0">
              {actual.label}
            </StatusBadge>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The agents this Console runs itself, moved here all at once ("Move all") or
 * brought back all at once. Each agent can also be moved on its own page.
 */
function ConsoleAgentsHere({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const movedKey = ['agent-migration', 'this-computer', serverId];
  const moved = useQuery({
    queryKey: movedKey,
    queryFn: () => rpc.agentMigration.movedOntoThisComputer(serverId),
    refetchInterval: REFRESH_MS,
  });
  const [outcome, setOutcome] = useState<string[] | null>(null);
  const settle = (lines: string[]) => {
    setOutcome(lines);
    void queryClient.invalidateQueries({ queryKey: movedKey });
    void queryClient.invalidateQueries({ queryKey: overviewKey(serverId) });
    void queryClient.invalidateQueries({ queryKey: ['agent-migration'] });
  };
  const moveAll = useMutation({
    mutationFn: () => rpc.agentMigration.moveAllOnThisComputer(serverId),
    onSuccess: (result) => settle(moveAllSummary(result, 'Moved')),
  });
  const bringBack = useMutation({
    mutationFn: () => rpc.agentMigration.stopManagingAllOnThisComputer(serverId),
    onSuccess: (result) => settle(moveAllSummary(result, 'Brought back')),
  });
  const working = moveAll.isPending || bringBack.isPending;
  const failure = moveAll.error ?? bringBack.error;
  const names = moved.data ?? [];
  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2">
      <p className="text-sm text-foreground">Agents this Console runs</p>
      <p className="text-xs text-foreground-muted">
        Move every agent this Console runs on this computer for this server onto its controller, so
        Switch manages them. {IDLE_RULE} Agents that cannot move are left as they are, with the
        reason.
      </p>
      {names.length > 0 && (
        <p className="text-xs text-foreground-muted">Moved here: {names.join(', ')}.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={working} onClick={() => moveAll.mutate()}>
          {moveAll.isPending ? 'Moving…' : 'Move all'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={working || names.length === 0}
          onClick={() => bringBack.mutate()}
        >
          {bringBack.isPending ? 'Bringing back…' : 'Bring all back'}
        </Button>
      </div>
      {outcome && (
        <ul className="space-y-0.5 text-xs text-foreground-muted">
          {outcome.map((line) => (
            <li key={line}>{line}</li>
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

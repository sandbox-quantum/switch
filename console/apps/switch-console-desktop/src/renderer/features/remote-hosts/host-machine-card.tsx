import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { moveAllSummary } from '@renderer/features/agent-migration/agent-migration-presentation';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useStateBoundFailure } from '@renderer/lib/hooks/use-state-bound-failure';
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
import type { HostControllerOverview } from '@shared/core/host-controllers/host-controllers';
import { hostControllerStateChannel } from '@shared/events/hostControllerEvents';
import {
  canRestartHost,
  failureAlreadyShown,
  hostAgentActual,
  type HostMachineTone,
  hostMachineStatus,
  hostStateKey,
  hostToggleBlocker,
  supervisionNote,
} from './host-machine';

const REFRESH_MS = 15_000;

const TONE: Record<HostMachineTone, StatusTone> = {
  neutral: 'neutral',
  busy: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'danger',
};

function overviewKey(sshHost: string, serverId: string): readonly unknown[] {
  return ['host-controller', sshHost, serverId];
}

/**
 * "This host as a machine": the agents controller Console installs and runs on
 * an SSH host for a Switch server, the managed agents placed there, and moving
 * this Console's agents on the host onto it.
 */
export function HostMachineCard({
  sshHost,
  serverId,
  workspaceId,
}: {
  sshHost: string;
  serverId: string;
  workspaceId: string | null;
}) {
  const queryClient = useQueryClient();
  const key = overviewKey(sshHost, serverId);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [outcome, setOutcome] = useState<string[] | null>(null);
  const query = useQuery({
    queryKey: [...key, workspaceId],
    queryFn: () => rpc.hostControllers.getOverview({ sshHost, serverId, workspaceId }),
    refetchInterval: REFRESH_MS,
  });
  useEffect(
    () =>
      events.on(hostControllerStateChannel, (event) => {
        if (event.sshHost !== sshHost || event.serverId !== serverId) return;
        void queryClient.invalidateQueries({ queryKey: overviewKey(sshHost, serverId) });
      }),
    [queryClient, sshHost, serverId]
  );
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['agent-migration'] }),
    ]);
  };
  const failed = useStateBoundFailure(query.data ? hostStateKey(query.data) : null);
  const handlers = {
    onSuccess: async () => {
      failed.clear();
      await refresh();
    },
    onError: async (error: Error) => {
      await refresh();
      const fresh = queryClient.getQueryData<HostControllerOverview>([...key, workspaceId]);
      failed.fail(error, fresh ? hostStateKey(fresh) : null);
    },
  };
  const enable = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error('Open a workspace on this server first.');
      return rpc.hostControllers.enable({ sshHost, serverId, workspaceId });
    },
    ...handlers,
  });
  const disable = useMutation({
    mutationFn: () => rpc.hostControllers.disable({ sshHost, serverId }),
    ...handlers,
  });
  const restart = useMutation({
    mutationFn: () => rpc.hostControllers.restart({ sshHost, serverId }),
    ...handlers,
  });
  const moveAll = useMutation({
    mutationFn: () => rpc.hostControllers.moveAll(sshHost),
    ...handlers,
    onSuccess: async (result) => {
      setOutcome(moveAllSummary(result, 'Moved'));
      await handlers.onSuccess();
    },
  });
  const bringBack = useMutation({
    mutationFn: () => rpc.hostControllers.stopManagingAll(sshHost),
    ...handlers,
    onSuccess: async (result) => {
      setOutcome(moveAllSummary(result, 'Brought back'));
      await handlers.onSuccess();
    },
  });

  const overview = query.data;
  if (!overview)
    return (
      <section className="rounded-lg border border-border p-4">
        <Heading />
        <p className="mt-2 text-xs text-foreground-muted">
          {query.error ? failureText(query.error, 'Could not read the host’s state.') : 'Loading…'}
        </p>
      </section>
    );

  const status = hostMachineStatus(overview);
  const blocker = hostToggleBlocker(overview);
  const checked = overview.enrollment !== null || overview.phase.kind === 'installing';
  const note = supervisionNote(overview);
  const running = overview.enrollment !== null && overview.process?.kind === 'running';
  const failure =
    failed.failure && !failureAlreadyShown(overview, failed.failure.message)
      ? failed.failure
      : null;
  const moving = moveAll.isPending || bringBack.isPending;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <Heading />
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={TONE[status.tone]}>{status.label}</StatusBadge>
          <Switch
            aria-label="Run managed agents on this host"
            checked={checked}
            disabled={blocker !== null}
            onCheckedChange={(next) => {
              failed.clear();
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
          className={`text-xs break-words whitespace-pre-wrap ${status.tone === 'error' ? 'text-foreground-error' : 'text-foreground-muted'}`}
        >
          {status.detail}
        </p>
      )}
      {note && <p className="text-xs text-foreground-muted">{note}</p>}
      {failure && (
        <p className="text-xs break-words text-foreground-error">
          {failureText(failure, 'That did not work.')}
        </p>
      )}
      {canRestartHost(overview) && (
        <Button
          variant="outline"
          size="sm"
          disabled={restart.isPending}
          onClick={() => restart.mutate()}
        >
          <RefreshCw className="size-4" /> Start again
        </Button>
      )}

      {overview.remote?.kind === 'ok' && overview.enrollment && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {overview.remote.agents.length === 0 && (
            <li className="px-3 py-2 text-xs text-foreground-muted">
              No managed agents are placed on this host yet.
            </li>
          )}
          {overview.remote.agents.map((agent) => {
            const actual = hostAgentActual(overview, agent);
            return (
              <li key={agent.agentId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {agent.displayName ?? agent.name}
                  </p>
                  <p className="truncate text-xs text-foreground-muted">
                    {agent.provider} · wanted {agent.desiredState}
                    {actual.detail ? ` · ${actual.detail}` : ''}
                  </p>
                </div>
                <StatusBadge tone={TONE[actual.tone]} className="shrink-0">
                  {actual.label}
                </StatusBadge>
              </li>
            );
          })}
        </ul>
      )}

      {running && (
        <div className="space-y-2 rounded-lg border border-border px-3 py-2">
          <p className="text-sm text-foreground">Agents this Console runs on this host</p>
          <p className="text-xs text-foreground-muted">
            Move them onto the host’s controller, so Switch manages them. {IDLE_RULE}
          </p>
          {overview.movedAgents.length > 0 && (
            <p className="text-xs text-foreground-muted">
              Moved here: {overview.movedAgents.join(', ')}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={moving} onClick={() => moveAll.mutate()}>
              {moveAll.isPending ? 'Moving…' : 'Move all'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={moving || overview.movedAgents.length === 0}
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
        </div>
      )}

      <Dialog open={confirmingOff} onOpenChange={setConfirmingOff}>
        <DialogContent>
          <DialogHeader>
            <TriangleAlert className="size-4 text-amber-500" />
            <DialogTitle>Stop running managed agents on {sshHost}?</DialogTitle>
          </DialogHeader>
          <DialogContentArea>
            <DialogDescription>
              This removes the host from Switch as a machine, stops the managed agents placed on it
              and removes the controller’s identity from the host. The agents stay defined in
              Switch, and can be placed on another machine.
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
              Remove this host
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Heading() {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Server className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">This host as a machine</h3>
        <p className="text-xs text-foreground-muted">
          Run managed agents on this host: Console installs Switch’s agents controller here, and
          Switch can place agents on it. It keeps running when Console is closed.
        </p>
      </div>
    </div>
  );
}

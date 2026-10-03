import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
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
import {
  type AgentMigrationState,
  IDLE_RULE,
  SESSIONS_ON_MOVE,
  SESSIONS_ON_RETURN,
} from '@shared/core/agent-migration/agent-migration';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';
import {
  migrationAction,
  migrationSummary,
  type MigrationTone,
  targetName,
} from './agent-migration-presentation';

const TONE: Record<MigrationTone, StatusTone> = {
  neutral: 'neutral',
  busy: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'danger',
};

const REFRESH_MS = 10_000;

export function migrationStateKey(agentId: string): readonly unknown[] {
  return ['agent-migration', agentId];
}

/** Where the agent runs (this Console, or a managed machine), kept fresh. */
export function useAgentMigrationState(agentId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: migrationStateKey(agentId),
    queryFn: () => rpc.agentMigration.getState(agentId),
    refetchInterval: REFRESH_MS,
  });
  useEffect(
    () =>
      events.on(agentMigrationChannel, (event) => {
        if (event.agentId !== agentId) return;
        queryClient.setQueryData<AgentMigrationState>(migrationStateKey(agentId), (current) =>
          current ? { ...current, runner: event.runner, operation: event.operation } : current
        );
        if (!event.operation)
          void queryClient.invalidateQueries({ queryKey: migrationStateKey(agentId) });
      }),
    [agentId, queryClient]
  );
  return query;
}

/**
 * "Move to managed" and "Stop managing" for one agent: hands the agent to
 * Switch's agent management, which runs it on a machine's controller, and
 * brings it back to this Console.
 */
export function ManagedAgentSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const query = useAgentMigrationState(agentId);
  const [confirming, setConfirming] = useState<'move' | 'return' | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: migrationStateKey(agentId) });
    void queryClient.invalidateQueries({ queryKey: ['shared-host', agentId] });
  };
  const move = useMutation({
    mutationFn: () => rpc.agentMigration.moveToManaged(agentId),
    onSettled: refresh,
  });
  const giveBack = useMutation({
    mutationFn: () => rpc.agentMigration.stopManaging(agentId),
    onSettled: refresh,
  });
  const cancel = useMutation({ mutationFn: () => rpc.agentMigration.cancel(agentId) });
  const enable = useMutation({
    mutationFn: () => {
      const agent = agentsStore.agentById(agentId);
      const target = query.data?.target;
      if (!agent?.workspaceId || !target) throw new Error('Open the agent’s workspace first.');
      return target.kind === 'this-computer'
        ? rpc.embeddedController.enable({
            serverId: target.serverId,
            workspaceId: agent.workspaceId,
          })
        : rpc.hostControllers.enable({
            sshHost: target.sshHost,
            serverId: target.serverId,
            workspaceId: agent.workspaceId,
          });
    },
    onSettled: refresh,
  });

  const state = query.data;
  if (!state)
    return (
      <p className="text-sm text-foreground-muted">
        {query.error
          ? failureText(query.error, 'Could not tell where this agent runs.')
          : 'Checking where this agent runs…'}
      </p>
    );

  const summary = migrationSummary(state);
  const action = migrationAction(state);
  const where = targetName(state.target);
  const failure = move.error ?? giveBack.error ?? enable.error;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Server className="size-4 text-foreground-muted" />
        <span className="font-medium">Managed by Switch</span>
        <StatusBadge tone={TONE[summary.tone]} className="ml-auto">
          {summary.label}
        </StatusBadge>
      </div>
      {summary.detail && <p className="text-sm text-foreground-muted">{summary.detail}</p>}
      {state.runner === 'console' && !state.operation && !state.movesWithParent && (
        <p className="text-sm text-foreground-muted">
          Move to managed hands this agent to Switch’s agent management, which runs it on {where}{' '}
          instead of this Console. {IDLE_RULE}
          {state.subagents.length > 0 &&
            ` Its subagents ${state.subagents.join(', ')} move with it.`}
        </p>
      )}
      {state.runner === 'managed' &&
        !state.operation &&
        !state.movesWithParent &&
        state.managed?.machine.kind !== 'removed' && (
          <p className="text-sm text-foreground-muted">
            This Console does not run it while it is managed: its room watcher here is off and its
            sessions run on the machine. Stop managing brings it back. {IDLE_RULE}
          </p>
        )}
      {state.movesWithParent && (
        <p className="text-sm text-foreground-muted">
          Watched under {state.movesWithParent}: it moves to a managed machine, and comes back, with
          it.
        </p>
      )}
      {state.blocker && !state.operation && !state.movesWithParent && (
        <p role="alert" className="text-sm text-foreground-muted">
          {state.blocker}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm break-words text-destructive">
          {failureText(failure, 'That did not work.')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {action && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.disabledReason !== null || move.isPending || giveBack.isPending}
            onClick={() => {
              move.reset();
              giveBack.reset();
              setConfirming(action.kind);
            }}
          >
            <ArrowRightLeft className="size-3.5" /> {action.label}
          </Button>
        )}
        {state.canEnableTarget && state.target && (
          <Button
            variant="outline"
            size="sm"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            {state.target.kind === 'this-computer'
              ? 'Run managed agents on this computer'
              : `Run managed agents on ${state.target.sshHost}`}
          </Button>
        )}
        {state.operation?.stage === 'waiting-for-turn' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        )}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <TriangleAlert className="size-4 text-amber-500" />
            <DialogTitle>
              {confirming === 'move' ? `Move it to ${where}?` : 'Bring it back to this Console?'}
            </DialogTitle>
          </DialogHeader>
          <DialogContentArea>
            <DialogDescription>
              {confirming === 'move'
                ? `Switch’s agent management will run this agent on ${where}, and this Console stops running it. ${SESSIONS_ON_MOVE} ${IDLE_RULE}`
                : `Switch stops managing this agent, the machine stops it, and this Console runs it again. ${SESSIONS_ON_RETURN} ${IDLE_RULE}`}
            </DialogDescription>
            {confirming === 'move' && state.notCarried.length > 0 && (
              <div className="mt-3 space-y-1 text-sm">
                <p className="font-medium">Not carried over to the managed agent:</p>
                <ul className="list-disc space-y-1 pl-5 text-foreground-muted">
                  {state.notCarried.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </DialogContentArea>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              onClick={() => {
                const kind = confirming;
                setConfirming(null);
                if (kind === 'move') move.mutate();
                else giveBack.mutate();
              }}
            >
              {confirming === 'move' ? 'Move to managed' : 'Stop managing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

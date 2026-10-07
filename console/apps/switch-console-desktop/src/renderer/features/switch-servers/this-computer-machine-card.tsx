import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Computer, ExternalLink, Pencil, RefreshCw, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { MoveAllAgents } from '@renderer/features/agent-migration/move-all-agents';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
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
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import {
  type EmbeddedControllerOverview,
  MAX_MACHINE_DESCRIPTION,
  MAX_MACHINE_NAME,
  type MachineDetailsChange,
} from '@shared/core/embedded-controller/embedded-controller';
import { embeddedControllerStateChannel } from '@shared/events/embeddedControllerEvents';
import { switchServersStore } from './switch-servers-store';
import {
  canStartAgain,
  machineStateKey,
  machineStatus,
  type MachineStatusTone,
  toggleBlocker,
  toggleChecked,
} from './this-computer-machine';

/** How often the card re-reads the server while it is on screen. */
const REFRESH_MS = 10_000;
const CONNECTING_REFRESH_MS = 1_000;

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
    // Every second while the controller runs but Switch does not list it online yet.
    refetchInterval: (query) => {
      const data = query.state.data;
      const reaching =
        data?.phase.kind === 'running' &&
        data.remote?.kind === 'ok' &&
        data.remote.controller?.state !== 'online';
      return reaching ? CONNECTING_REFRESH_MS : REFRESH_MS;
    },
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
  const failed = useStateBoundFailure(
    overviewQuery.data ? machineStateKey(overviewQuery.data) : null
  );
  const handlers = {
    onSuccess: async () => {
      failed.clear();
      await refresh();
    },
    onError: async (error: Error) => {
      await refresh();
      const fresh = queryClient.getQueryData<EmbeddedControllerOverview>([
        ...overviewKey(serverId),
        workspaceId,
      ]);
      failed.fail(error, fresh ? machineStateKey(fresh) : null);
    },
  };
  const enable = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error('Open a workspace on this server first.');
      return rpc.embeddedController.enable({ serverId, workspaceId });
    },
    ...handlers,
  });
  const disable = useMutation({
    mutationFn: () => rpc.embeddedController.disable(serverId),
    ...handlers,
  });
  const startAgain = useMutation({
    mutationFn: () => rpc.embeddedController.restart(serverId),
    ...handlers,
  });
  const dismiss = useMutation({
    mutationFn: () => rpc.embeddedController.dismissRemoved(serverId),
    ...handlers,
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

  const status = machineStatus(overview, Date.now());
  const blocker = toggleBlocker(overview);
  const checked = toggleChecked(overview);
  const failure = failed.failure;

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

      {overview.enrollment && (
        <MachineDetails serverId={serverId} overview={overview} onSaved={refresh} />
      )}

      {overview.enrollment && overview.phase.kind === 'running' && workspaceId && (
        <MoveAllAgents serverId={serverId} workspaceId={workspaceId} />
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
              moved to another machine. Agents this Console runs itself are not affected; any moved
              here from this Console have to be brought back first.
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

/**
 * This computer's name and description as a machine on the server, which its
 * owner sees on the Machines page and agents allowed to manage agents read
 * when they pick a machine, with an edit action.
 */
function MachineDetails({
  serverId,
  overview,
  onSaved,
}: {
  serverId: string;
  overview: EmbeddedControllerOverview;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const save = useMutation({
    mutationFn: (changes: MachineDetailsChange) =>
      rpc.embeddedController.updateDetails({ serverId, changes }),
    onSuccess: () => setEditing(false),
    onSettled: onSaved,
  });

  const remote = overview.remote;
  const controller = remote?.kind === 'ok' ? remote.controller : null;
  if (!controller || controller.state === 'revoked') return null;

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameProblem = !trimmedName
    ? 'A machine needs a name.'
    : trimmedName.length > MAX_MACHINE_NAME
      ? `At most ${MAX_MACHINE_NAME} characters.`
      : null;
  const descriptionProblem =
    trimmedDescription.length > MAX_MACHINE_DESCRIPTION
      ? `At most ${MAX_MACHINE_DESCRIPTION} characters.`
      : null;
  const changes: MachineDetailsChange = {
    ...(trimmedName !== controller.name ? { name: trimmedName } : {}),
    ...(trimmedDescription !== (controller.description ?? '')
      ? { description: trimmedDescription || null }
      : {}),
  };

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{controller.name}</p>
        <p className="truncate text-xs text-foreground-muted">
          {controller.description ?? 'No description'}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Rename or describe this computer"
        onClick={() => {
          setName(controller.name);
          setDescription(controller.description ?? '');
          save.reset();
          setEditing(true);
        }}
      >
        <Pencil className="size-4" />
        Edit
      </Button>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This computer as a machine</DialogTitle>
          </DialogHeader>
          <DialogContentArea className="gap-3">
            <DialogDescription>
              The name and description your Machines page shows, and that agents you allow to manage
              agents see when they pick a machine.
            </DialogDescription>
            <div className="space-y-1">
              <Label htmlFor="machine-name">Name</Label>
              <Input
                id="machine-name"
                value={name}
                aria-invalid={nameProblem !== null}
                onChange={(event) => setName(event.target.value)}
              />
              {nameProblem && <p className="text-xs text-foreground-error">{nameProblem}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="machine-description">Description</Label>
              <Textarea
                id="machine-description"
                value={description}
                placeholder="What this computer is for"
                aria-invalid={descriptionProblem !== null}
                onChange={(event) => setDescription(event.target.value)}
              />
              {descriptionProblem && (
                <p className="text-xs text-foreground-error">{descriptionProblem}</p>
              )}
            </div>
            {save.error && (
              <p className="text-xs text-foreground-error">
                {failureText(save.error, 'Could not save.')}
              </p>
            )}
          </DialogContentArea>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={
                save.isPending ||
                nameProblem !== null ||
                descriptionProblem !== null ||
                Object.keys(changes).length === 0
              }
              onClick={() => save.mutate(changes)}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import {
  MANAGED_AGENTS_KEY,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { MachineIcon, TonePill } from './machine-marks';
import { machineKindLabel, moveTarget } from './machine-state';

type Props = BaseModalProps<void> & { agent: ManagedAgentView };

const LINE_TEXT = {
  ok: 'text-foreground-muted',
  warning: 'text-foreground-warning',
  problem: 'text-foreground-error',
  idle: 'text-foreground-muted',
} as const;

/**
 * Moves a managed agent to another of its owner's machines. Each machine says
 * whether it can take the agent, by the rules Switch places it by; the ones
 * that cannot are listed but not picked. Its files stay where they are.
 */
export function MoveAgentModal({ agent, onSuccess, onClose }: Props) {
  const machines = useOwnedMachines(agent.serverId);
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = managedAgentLabel(agent);
  const provider = agent.definition.provider;
  const others = (machines.data ?? []).filter(
    (machine) => machine.id !== agent.machine?.id && machine.state !== 'revoked'
  );
  const folder = agent.status?.directory ?? agent.definition.directory;

  const move = async () => {
    if (!picked) return;
    setMoving(true);
    setError(null);
    try {
      await rpc.managedAgents.update({
        serverId: agent.serverId,
        agentId: agent.agentId,
        changes: { definition: {}, machineId: picked },
      });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, agent.serverId] });
      onSuccess();
    } catch (err) {
      setError(failureText(err, `Could not move ${label}.`));
      setMoving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Move {label} to another machine</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <DialogDescription>
          {label} stops on {agent.machine?.name ?? 'its machine'} and starts on the machine you
          pick. Its chats, rooms and settings stay the same.
        </DialogDescription>
        {machines.error ? (
          <p role="alert" className="text-sm text-destructive">
            {failureText(machines.error, 'Could not read your machines.')}
          </p>
        ) : machines.data === undefined ? (
          <Spinner />
        ) : others.length === 0 ? (
          <p className="text-sm text-foreground-muted">You have no other machine to move it to.</p>
        ) : (
          <div role="radiogroup" className="max-h-[360px] space-y-2 overflow-y-auto">
            {others.map((machine) => (
              <TargetRow
                key={machine.id}
                machine={machine}
                provider={provider}
                picked={picked === machine.id}
                onPick={() => setPicked(machine.id)}
              />
            ))}
          </div>
        )}
        <p className="flex gap-2 rounded-md bg-background-tertiary px-3 py-2 text-xs text-foreground-muted">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            Files in its working folder{folder ? ` (${folder})` : ''} don&apos;t move. Anything it
            needs from there must be on the new machine.
          </span>
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void move()} disabled={!picked || moving}>
          {moving ? 'Moving…' : `Move ${label}`}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}

function TargetRow({
  machine,
  provider,
  picked,
  onPick,
}: {
  machine: OwnedMachine;
  provider: string;
  picked: boolean;
  onPick: () => void;
}) {
  const target = moveTarget(machine, provider);
  const online = machine.state === 'online';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      disabled={!target.selectable}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        picked ? 'border-foreground' : 'border-border',
        target.selectable
          ? 'cursor-pointer hover:bg-[var(--sel-soft)]'
          : 'cursor-not-allowed opacity-60'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border',
          picked ? 'border-foreground' : 'border-border'
        )}
      >
        {picked && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <MachineIcon machine={machine} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">
            {machine.local?.kind === 'this-computer' ? 'This computer' : machine.name}
          </span>
          <TonePill tone="idle" dot={false} label={machineKindLabel(machine).split(' · ')[0]!} />
          <TonePill tone={online ? 'ok' : 'problem'} label={online ? 'Online' : 'Offline'} />
        </span>
        <span className={cn('mt-0.5 block truncate text-xs', LINE_TEXT[target.tone])}>
          {target.line}
        </span>
      </span>
    </button>
  );
}

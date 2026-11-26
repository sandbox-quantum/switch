import { Info } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../model/cn';
import { Button } from '../primitives/button';
import {
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../primitives/dialog';
import { Spinner } from '../primitives/spinner';

export type MoveAgentMachine = {
  id: string;
  name: string;
  kind: string;
  kindLabel?: string;
  icon?: React.ReactNode;
  state: string;
  thisComputer: boolean;
  selectable: boolean;
  selectabilityTone: 'ok' | 'warning' | 'problem' | 'idle';
  selectabilityLine: string;
  namesake: string | null;
};

export type MoveAgentModalProps = {
  agentName: string;
  currentMachineName: string | null;
  workingDirectory: string | null;
  machines: MoveAgentMachine[] | null;
  machinesError: string | null;
  moving: boolean;
  moveError: string | null;
  onMove: (machineId: string) => Promise<void>;
  onClose: () => void;
  confirmLabel?: string;
  confirmButtonRef?: React.RefObject<HTMLButtonElement | null>;
};

const LINE_TEXT = {
  ok: 'text-foreground-muted',
  warning: 'text-foreground-warning',
  problem: 'text-foreground-error',
  idle: 'text-foreground-muted',
} as const;

const TONE_PILL_COLORS = {
  ok: 'bg-green-500/10 text-green-700 dark:text-green-400',
  problem: 'bg-red-500/10 text-red-700 dark:text-red-400',
  idle: 'bg-gray-500/10 text-gray-700 dark:text-gray-400',
  warning: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
} as const;

function TonePill({ tone, label, dot = true }: { tone: keyof typeof TONE_PILL_COLORS; label: string; dot?: boolean }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
        TONE_PILL_COLORS[tone]
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}

function MachineIcon({ kind, icon }: { kind: string; icon?: React.ReactNode }) {
  if (icon) {
    return <div className="flex size-6 shrink-0 items-center justify-center">{icon}</div>;
  }
  return (
    <div className="flex size-6 shrink-0 items-center justify-center rounded bg-background-2">
      <span className="text-xs text-foreground-muted">{kind === 'ec2' ? '☁️' : '💻'}</span>
    </div>
  );
}

function TargetRow({
  machine,
  picked,
  onPick,
}: {
  machine: MoveAgentMachine;
  picked: boolean;
  onPick: () => void;
}) {
  const online = machine.state === 'online';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      disabled={!machine.selectable}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        picked ? 'border-foreground' : 'border-border',
        machine.selectable
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
      <MachineIcon kind={machine.kind} icon={machine.icon} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">
            {machine.thisComputer ? 'This computer' : machine.name}
          </span>
          {!machine.thisComputer && machine.kind !== 'unknown' && machine.kindLabel && (
            <TonePill
              tone="idle"
              dot={false}
              label={machine.kindLabel}
            />
          )}
          {!machine.thisComputer && machine.kind !== 'unknown' && !machine.kindLabel && (
            <TonePill
              tone="idle"
              dot={false}
              label={machine.kind === 'ec2' ? 'Cloud' : 'Desktop'}
            />
          )}
          <TonePill tone={online ? 'ok' : 'problem'} label={online ? 'Online' : 'Offline'} />
          {machine.namesake && (
            <span className="shrink-0 text-xs text-foreground-muted">{machine.namesake}</span>
          )}
        </span>
        <span className={cn('mt-0.5 block truncate text-xs', LINE_TEXT[machine.selectabilityTone])}>
          {machine.selectabilityLine}
        </span>
      </span>
    </button>
  );
}

/**
 * Moves a managed agent to another device. Each machine says whether it can
 * take the agent; the ones that cannot are listed but not selectable. The
 * agent's files stay where they are.
 */
export function MoveAgentModal({
  agentName,
  currentMachineName,
  workingDirectory,
  machines,
  machinesError,
  moving,
  moveError,
  onMove,
  onClose,
  confirmLabel = 'Move',
  confirmButtonRef,
}: MoveAgentModalProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const chosen =
    machines?.find((m) => m.id === picked && m.selectable)?.id ?? null;

  const handleMove = async () => {
    if (!chosen) return;
    try {
      await onMove(chosen);
    } catch {
      // Error is shown via moveError prop from wrapper
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Move {agentName} to another device</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <DialogDescription>
          {agentName} stops on {currentMachineName ?? 'its device'} and starts on the device you
          pick. Its chats, rooms and settings stay the same.
        </DialogDescription>
        <p id="move-to-label" className="text-[12px] text-foreground-muted">
          Move to
        </p>
        {machinesError ? (
          <p role="alert" className="text-sm text-destructive">
            {machinesError}
          </p>
        ) : machines === null ? (
          <Spinner />
        ) : machines.length === 0 ? (
          <p className="text-sm text-foreground-muted">You have no other device to move it to.</p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="move-to-label"
            className="max-h-[360px] space-y-2 overflow-y-auto"
          >
            {machines.map((machine) => (
              <TargetRow
                key={machine.id}
                machine={machine}
                picked={chosen === machine.id}
                onPick={() => setPicked(machine.id)}
              />
            ))}
          </div>
        )}
        <p className="flex gap-2 rounded-md bg-background-tertiary px-3 py-2 text-xs text-foreground-muted">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            Files in its working folder
            {workingDirectory ? ` (${workingDirectory})` : ''} don&apos;t move. Anything it needs
            from there must be on the new device.
          </span>
        </p>
        {moveError && (
          <p role="alert" className="text-xs text-destructive">
            {moveError}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button ref={confirmButtonRef} onClick={() => void handleMove()} disabled={!chosen || moving}>
          {moving ? 'Moving…' : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

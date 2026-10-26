import { Cloud, Laptop, Monitor, Server } from 'lucide-react';
import { cn } from '@renderer/utils/utils';
import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';
import type { MachineTone } from './machine-state';

export const TONE_DOT: Record<MachineTone, string> = {
  ok: 'bg-green-500',
  warning: 'bg-amber-500',
  problem: 'bg-red-500',
  idle: 'bg-foreground-muted',
};

const PILL: Record<MachineTone, string> = {
  ok: 'bg-background-success text-foreground-success',
  warning: 'bg-background-warning text-foreground-warning',
  problem: 'bg-background-error text-foreground-error',
  idle: 'bg-background-tertiary text-foreground-muted',
};

export function TonePill({
  tone,
  label,
  title,
  dot = true,
}: {
  tone: MachineTone;
  label: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] whitespace-nowrap',
        PILL[tone]
      )}
    >
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {label}
    </span>
  );
}

/** What kind of machine it is, as an icon: this computer, a cloud machine, a Console, or a server. */
export function MachineIcon({
  machine,
  className,
}: {
  machine: MachineDetail;
  className?: string;
}) {
  const Icon =
    machine.local?.kind === 'this-computer'
      ? Laptop
      : machine.cloud
        ? Cloud
        : machine.kind === 'console'
          ? Monitor
          : Server;
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background',
        className
      )}
    >
      <Icon className="size-4 text-foreground-muted" />
    </span>
  );
}

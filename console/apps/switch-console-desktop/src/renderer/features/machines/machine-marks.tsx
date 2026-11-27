import { Cloud, Laptop, Monitor, Server } from 'lucide-react';
import { cn } from '@renderer/utils/utils';
import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';

/** What kind of machine it is, as an icon: this computer, a cloud machine, a Console, or a server. */
export function MachineIcon({
  machine,
  className,
}: {
  machine: Pick<MachineDetail, 'local' | 'cloud' | 'kind'>;
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

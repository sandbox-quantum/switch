import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { InstalledBadge, UninstalledBadge } from '@renderer/lib/components/provider-status-badges';
import { cn } from '@renderer/utils/utils';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';
import { reportedLine } from './reported-provider';

/**
 * One agent provider on one machine: its icon and name, whether it is
 * installed, and a status line under them. Settings → Agent providers lists
 * this computer's providers with it and a machine's page lists that
 * machine's, so the two read alike.
 */
export function ProviderStatusRow({
  providerId,
  name,
  installed,
  status,
  action,
  onClick,
}: {
  providerId: string;
  name: string;
  installed: boolean;
  /** The line under the name: sign-in state, or a check in progress. */
  status: ReactNode;
  /** A control beside the row, outside its button (Recheck). */
  action?: ReactNode;
  /** Makes the whole row a button. */
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  const row = (
    <Tag
      className={cn(
        'group flex w-full min-w-0 items-center gap-3 rounded-lg p-3 hover:bg-background-1',
        onClick && 'cursor-pointer text-left'
      )}
      onClick={onClick}
    >
      <div className="flex size-6 items-center justify-center rounded-lg bg-background-1 p-1.5 group-hover:bg-background-2">
        <AgentIcon id={providerId} size={16} />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        <div className="flex w-full items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {installed ? <InstalledBadge /> : <UninstalledBadge />}
          </div>
        </div>
        {status}
      </div>
    </Tag>
  );
  if (!action) return row;
  return (
    <div className="flex w-full items-center gap-1">
      {row}
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/** The status line for a provider as a machine's controller reported it. */
export function ReportedProviderLine({
  reported,
  checking,
}: {
  reported: MachineProvider;
  /** A recheck is under way: says so rather than repeating the last answer. */
  checking: boolean;
}) {
  const headline = checking ? 'Checking installation and sign-in…' : reportedLine(reported);
  const Icon = checking ? Loader2 : reported.ready ? CheckCircle2 : CircleAlert;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-xs',
        checking || reported.ready ? 'text-foreground-muted' : 'text-foreground-warning'
      )}
      title={checking ? undefined : (reported.detail ?? undefined)}
    >
      <Icon className={cn('size-3.5 shrink-0', checking && 'animate-spin')} />
      <span className="truncate">{headline}</span>
    </span>
  );
}

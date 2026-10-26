import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { InstalledBadge, UninstalledBadge } from '@renderer/lib/components/provider-status-badges';
import { cn } from '@renderer/utils/utils';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';
import { reportedHeadline } from './reported-provider';

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
  meta,
  actions,
  onClick,
}: {
  providerId: string;
  name: string;
  installed: boolean;
  /** The line under the name: sign-in state, or a check in progress. */
  status: ReactNode;
  /** A short note after the name, such as the version. */
  meta?: string;
  /** Buttons beside the badge. Not with `onClick`: a button cannot hold buttons. */
  actions?: ReactNode;
  /** Makes the whole row a button. */
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg p-3 hover:bg-background-1',
        onClick && 'cursor-pointer text-left'
      )}
      onClick={onClick}
    >
      <div className="flex size-6 items-center justify-center rounded-lg bg-background-1 p-1.5 group-hover:bg-background-2">
        <AgentIcon id={providerId} size={16} />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        <div className="flex w-full items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm text-foreground">
            {name}
            {meta && <span className="text-foreground-muted"> · {meta}</span>}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            {installed ? <InstalledBadge /> : <UninstalledBadge />}
          </div>
        </div>
        {status}
      </div>
    </Tag>
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
  const busy = checking || reported.problem === 'login not checked yet';
  const headline = checking ? 'Checking installation and sign-in…' : reportedHeadline(reported);
  const Icon = busy ? Loader2 : reported.ready ? CheckCircle2 : CircleAlert;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        busy || reported.ready ? 'text-foreground-muted' : 'text-foreground-warning'
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', busy && 'animate-spin')} />
      {headline}
    </span>
  );
}

import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus } from '@shared/core/providers/agentEvents';

export type AgentIndicatorStatus = AgentStatus | null;

interface AgentStatusIndicatorProps {
  status: AgentIndicatorStatus;
  className?: string;
  disableTooltip?: boolean;
}

/**
 * What a session is doing, shown only while it is doing something.
 *
 * Working is the one state worth a mark in a list: it is the reason to wait,
 * and it ends on its own. The resting states — awaiting input, errored,
 * completed — used to each carry a coloured dot, and a column of them said
 * little at a glance while costing every row the same space. They are gone;
 * what a finished session actually did belongs on the session, not in a dot
 * whose colour has to be learned.
 */
export function AgentStatusIndicator({
  status,
  className,
  disableTooltip,
}: AgentStatusIndicatorProps) {
  if (status !== 'working') return null;

  const indicator = (
    <span className="flex size-6 items-center justify-center">
      <Spinner className={cn('size-3.5 text-foreground-muted', className)} />
    </span>
  );

  if (disableTooltip) return indicator;

  return (
    <Tooltip>
      <TooltipTrigger render={indicator} />
      <TooltipContent>Agent is working</TooltipContent>
    </Tooltip>
  );
}

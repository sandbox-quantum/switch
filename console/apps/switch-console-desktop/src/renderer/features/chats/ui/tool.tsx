import { ChevronRightIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';

export type ToolState = 'running' | 'done' | 'failed' | 'declined';

const STATE_PILL_CLASS: Record<ToolState, string> = {
  running: 'bg-background-warning text-foreground-warning',
  done: 'bg-background-success text-foreground-success',
  failed: 'bg-background-error text-foreground-error',
  declined: 'bg-background-2 text-foreground-passive',
};

/** One tool call in a transcript: a header that names it and a body that opens. */
export function Tool({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible
      data-slot="tool"
      className={cn(
        'w-full min-w-0 overflow-hidden rounded-lg border border-border bg-background-1',
        className
      )}
      {...props}
    />
  );
}

export function ToolHeader({
  title,
  state,
  icon,
  className,
}: {
  title: string;
  state: ToolState;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <CollapsibleTrigger
      data-slot="tool-header"
      data-state={state}
      className={cn(
        'group/tool-header flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left outline-none hover:bg-background-2 focus-visible:bg-background-2',
        className
      )}
    >
      {state === 'running' ? (
        <Spinner size="sm" className="size-3.5 shrink-0 text-foreground-warning" />
      ) : icon ? (
        <span className="flex shrink-0 text-foreground-muted [&_svg]:size-3.5">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{title}</span>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-micro font-medium',
          STATE_PILL_CLASS[state]
        )}
      >
        {state}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-passive transition-transform group-data-[panel-open]/tool-header:rotate-90 motion-reduce:transition-none" />
    </CollapsibleTrigger>
  );
}

export function ToolContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-content"
      className={cn('border-t border-border', className)}
      {...props}
    />
  );
}

export function ToolOutput({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="tool-output"
      className={cn(
        'max-h-80 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground-muted',
        className
      )}
    >
      {children}
    </div>
  );
}

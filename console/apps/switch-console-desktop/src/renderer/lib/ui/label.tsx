import * as React from 'react';
import { cn } from '@renderer/utils/utils';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm font-normal  tracking-tight leading-none text-foreground-muted select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export function MicroLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'cursor-default uppercase font-mono tracking-widest text-foreground-passive select-none text-xs',
        className
      )}
      {...props}
    />
  );
}

/**
 * The heading over a section of a panel — the sidebar's groups, the setup
 * checklist.
 *
 * Set in the interface face rather than {@link MicroLabel}'s monospace, and
 * not shouted: at this size caps read as noise rather than as hierarchy, and
 * the monospace belongs to card and dialog headers.
 */
export function SectionLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        // `--fg-passive`, not the `foreground-passive` token: that one is the
        // design's faint step and leaves a section heading too weak to read
        // without hovering it.
        'cursor-default text-xs font-medium text-[var(--fg-passive)] select-none',
        className
      )}
      {...props}
    />
  );
}

export { Label };

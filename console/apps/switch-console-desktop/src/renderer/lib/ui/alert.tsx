import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@renderer/utils/utils';

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-3 py-2 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-data-[slot=alert-action]:gap-x-2.5 has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto] *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-card text-foreground',
        warning:
          'bg-background-warning border-border-warning text-foreground-warning *:data-[slot=alert-description]:text-warning/90 *:[svg]:text-current',
        destructive:
          'bg-card text-foreground-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'text-sm group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-xs text-balance text-foreground-muted md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
        className
      )}
      {...props}
    />
  );
}

/**
 * Occupies the alert's trailing grid column rather than floating over the text.
 * Absolute positioning paired with a fixed reserved gutter only holds while the
 * action is narrower than the gutter; anything wider silently overlaps the
 * description.
 */
function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        'col-start-2 row-span-2 row-start-1 self-center justify-self-end group-has-[>svg]/alert:col-start-3',
        className
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };

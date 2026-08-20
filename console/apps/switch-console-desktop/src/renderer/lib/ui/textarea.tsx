import * as React from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * A multi-line field that grows with what it holds, up to a ceiling.
 *
 * The ceiling is the load-bearing half. `field-sizing-content` alone has no
 * upper bound, so a box given a whole agent prompt or a room's instructions
 * becomes as tall as the text and pushes the rest of the page out of sight
 * (CHOO-2203). Roughly a dozen lines, after which it scrolls inside itself.
 * A field that genuinely needs to open further overrides `max-h-*`.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content max-h-64 min-h-16 w-full rounded-md border border-border bg-transparent px-2.5 py-2 text-sm transition-[color,box-shadow] outline-none placeholder:text-foreground-passive hover:border-border-1 focus-visible:border focus-visible:border-border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className
      )}
      {...props}
    />
  );
}

export type TextareaProps = React.ComponentProps<'textarea'>;

export { Textarea };

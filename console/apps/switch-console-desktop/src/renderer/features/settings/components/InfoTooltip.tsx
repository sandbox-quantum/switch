import { Info } from 'lucide-react';
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';

/**
 * An "i" button that shows its explanation when clicked, and on hover. A
 * popover, not a tooltip: a tooltip closes when its trigger is clicked.
 */
export function InfoTooltip({ label, content }: { label: string; content: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={label}
        className="text-muted-foreground inline-flex h-4 w-4 cursor-pointer items-center justify-center hover:text-foreground"
      >
        <Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" className="max-w-xs gap-0 p-3 text-xs font-normal">
        {content}
      </PopoverContent>
    </Popover>
  );
}

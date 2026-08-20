import { Info } from 'lucide-react';
import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';

export function InfoTooltip({ label, content }: { label: string; content: React.ReactNode }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger>
          <button
            type="button"
            className="text-muted-foreground inline-flex h-4 w-4 items-center justify-center hover:text-foreground"
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

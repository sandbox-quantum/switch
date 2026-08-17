import { MoreVertical } from 'lucide-react';
import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import { sessionActions, type SessionActionsProps } from './session-actions';

/**
 * A session's actions, on a button.
 *
 * The same list the right-click menu offers, reachable without knowing to
 * right-click — which nothing in the interface says you can.
 */
export function SessionActionsMenu({
  sessionName,
  className,
  onOpenChange,
  ...actionProps
}: SessionActionsProps & {
  sessionName: string;
  className?: string;
  /** Told when the menu opens or closes, so a row that only reveals this
   * button on hover can keep it visible while its menu is up. */
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        className={cn(
          'flex size-6 items-center justify-center rounded-md text-foreground-tertiary-muted hover:bg-background-tertiary-2 hover:text-foreground-tertiary group-data-[active=true]/row:hover:bg-background-tertiary-3',
          className
        )}
        aria-label={`Actions for ${sessionName || 'session'}`}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreVertical className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sessionActions(actionProps).map((action) => (
          <React.Fragment key={action.key}>
            {action.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant={action.destructive ? 'destructive' : 'default'}
              onClick={action.run}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

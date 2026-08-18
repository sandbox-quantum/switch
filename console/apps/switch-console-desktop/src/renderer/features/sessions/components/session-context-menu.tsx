import React from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { sessionActions, type SessionActionsProps } from './session-actions';

export function SessionContextMenu({
  children,
  ...actionProps
}: SessionActionsProps & { children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {sessionActions(actionProps).map((action) => (
          <React.Fragment key={action.key}>
            {action.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem
              variant={action.destructive ? 'destructive' : 'default'}
              onClick={action.run}
            >
              {action.icon}
              {action.label}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

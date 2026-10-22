import { Link2, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { SessionActionsMenu } from '@renderer/features/sessions/components/session-actions-menu';
import { SessionContextMenu } from '@renderer/features/sessions/components/session-context-menu';
import {
  getSessionManagerStore,
  getSessionStore,
} from '@renderer/features/sessions/stores/session-selectors';
import { useSessionActionProps } from '@renderer/features/sessions/use-session-actions';
import { SessionIssueIndicator } from '@renderer/features/sidebar/session-issue-indicator';
import { SessionSidebarTrailingSlot } from '@renderer/features/sidebar/session-sidebar-agent-status';
import { SessionRoomConnection } from '@renderer/features/switch-rooms/session-room-connection';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { roomLabel } from './sidebar-room-grouping';
import { depthIndent } from './sidebar-store';

interface SidebarSessionItemProps {
  sessionId: string;
  locationId: string;
  /** Pinned strip uses tighter padding than sessions nested under a location. */
  rowVariant?: 'underLocation' | 'pinned';
  /** Tree depth of this row (ignored for the pinned strip). Drives the row's
   * left indent so a session aligns with the other entities at its depth. */
  depth?: number;
  /** The room this row is listed under, where rows are grouped by room. */
  roomKey?: string;
  /** Another session of the agent answers this row's room now. */
  superseded?: boolean;
}

export const SidebarSessionItem = observer(function SidebarSessionItem({
  sessionId,
  locationId,
  rowVariant = 'underLocation',
  depth = 0,
  roomKey,
  superseded = false,
}: SidebarSessionItemProps) {
  const { navigate } = useNavigate();
  const [actionsOpen, setActionsOpen] = useState(false);

  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  const isActive =
    currentView === 'session' && params.sessionId === sessionId && params.locationId === locationId;

  const session = getSessionStore(locationId, sessionId)!;
  const sessionManager = getSessionManagerStore(locationId);

  const sessionName = session.data.title;
  // A shared session answers several rooms from its home room. Under the home
  // room it carries a tag naming them; under one of the others it is a muted
  // pointer back to home. A room's earlier session, now superseded by a shared
  // one, is dimmed.
  const shares = roomConnectionsStore.sharedRoomsForSession(sessionId);
  const home = roomConnectionsStore.associatedRoomForSession(sessionId);
  const pointer = roomKey !== undefined && shares.includes(roomKey) && home !== null;

  const handleProvision = () => {
    if (session.state !== 'unprovisioned' || session.phase !== 'idle') return;
    void sessionManager?.provisionSession(sessionId, 'auto');
  };

  const openSession = () => {
    handleProvision();
    navigate('session', { locationId, sessionId });
  };

  const actions = useSessionActionProps(locationId, sessionId)!;

  return (
    <SessionContextMenu {...actions}>
      <SidebarMenuRow
        className="group/row flex items-center justify-between gap-[9px]"
        isActive={isActive}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openSession}
      >
        {/* Indent on the content, not the row, so the highlight still spans the
            sidebar's full width at every depth. The icon box is wider than a
            header row's and the gap tighter, which is what optically continues
            the 16px step without a third indent value. */}
        <div
          className="flex h-6 min-w-0 flex-1 items-center gap-1"
          style={rowVariant === 'pinned' ? { paddingLeft: 4 } : depthIndent(depth)}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            <MessageSquare className="h-4 w-4 text-foreground-muted" />
          </span>
          <SidebarMenuAction
            aria-label={`Open session ${sessionName || 'session'}`}
            className="gap-1 overflow-hidden"
          >
            {pointer ? (
              <span className="min-w-0 truncate text-left text-foreground-muted">
                answers from {roomLabel(home)}
              </span>
            ) : (
              <span
                className={cn(
                  'min-w-0 truncate text-left transition-colors',
                  (session.isBootstrapping || superseded) && 'text-foreground/40'
                )}
              >
                {sessionName}
              </span>
            )}
          </SidebarMenuAction>
          {!pointer && shares.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`Shared session: ${shares.length + 1} rooms`}
                    className="flex shrink-0 items-center gap-0.5 text-[11px] text-foreground-muted"
                  >
                    <Link2 className="size-3" />
                    {shares.length + 1}
                  </span>
                }
              />
              <TooltipContent>
                Shared session, answering{' '}
                {[home, ...shares]
                  .filter(Boolean)
                  .map((room) => roomLabel(room!))
                  .join(', ')}
              </TooltipContent>
            </Tooltip>
          )}
          <SessionIssueIndicator sessionId={sessionId} />
          {'agentId' in session.data && (
            <SessionRoomConnection compact sessionId={sessionId} agentId={session.data.agentId} />
          )}
        </div>
        {/* The status and the actions button take turns in one slot rather than
            sitting side by side: the row is narrow, and a second control
            appearing on hover would shorten the title just as it is being read. */}
        <div className="ml-2 flex min-w-6 shrink-0 items-center justify-end gap-1.5">
          {!actionsOpen && (
            <span className="flex items-center group-hover/row:hidden">
              <SessionSidebarTrailingSlot session={session} />
            </span>
          )}
          <SessionActionsMenu
            {...actions}
            sessionName={sessionName}
            className={actionsOpen ? 'flex' : 'hidden group-hover/row:flex'}
            onOpenChange={setActionsOpen}
          />
        </div>
      </SidebarMenuRow>
    </SessionContextMenu>
  );
});

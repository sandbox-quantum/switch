import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { SessionActionsMenu } from '@renderer/features/sessions/components/session-actions-menu';
import { SessionContextMenu } from '@renderer/features/sessions/components/session-context-menu';
import {
  getSessionManagerStore,
  getSessionStore,
} from '@renderer/features/sessions/stores/session-selectors';
import { SessionSidebarTrailingSlot } from '@renderer/features/sidebar/session-sidebar-agent-status';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { cn } from '@renderer/utils/utils';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { depthIndent } from './sidebar-store';

interface SidebarSessionItemProps {
  sessionId: string;
  locationId: string;
  /** Pinned strip uses tighter padding than sessions nested under a location. */
  rowVariant?: 'underLocation' | 'pinned';
  /** Tree depth of this row (ignored for the pinned strip). Drives the row's
   * left indent so a session aligns with the other entities at its depth. */
  depth?: number;
}

export const SidebarSessionItem = observer(function SidebarSessionItem({
  sessionId,
  locationId,
  rowVariant = 'underLocation',
  depth = 0,
}: SidebarSessionItemProps) {
  const { navigate } = useNavigate();
  const showRename = useShowModal('renameSessionModal');
  const showDeleteSession = useShowModal('deleteSessionModal');
  const [actionsOpen, setActionsOpen] = useState(false);

  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  const isActive =
    currentView === 'session' && params.sessionId === sessionId && params.locationId === locationId;

  const session = getSessionStore(locationId, sessionId)!;
  const sessionManager = getSessionManagerStore(locationId);

  const sessionName = session.data.title;

  const handleProvision = () => {
    if (session.state !== 'unprovisioned' || session.phase !== 'idle') return;
    void sessionManager?.provisionSession(sessionId, 'auto');
  };

  const openSession = () => {
    handleProvision();
    navigate('session', { locationId, sessionId });
  };

  const handleArchive = () => {
    if (isActive) navigate('location', { locationId });
    void sessionManager?.archiveSession(sessionId);
  };

  const handleRename = () => showRename({ locationId, sessionId, currentName: sessionName });

  const handleDelete = () =>
    showDeleteSession({
      locationId,
      sessions: [{ sessionId, sessionName }],
      onSuccess: () => {
        void sessionManager?.deleteSessions([sessionId]);
        if (isActive) navigate('location', { locationId });
      },
    });

  const canPin = session.state !== 'unregistered';

  const actions = {
    isPinned: session.data.isPinned,
    canPin,
    isArchived: false,
    onPin: () => void session.setPinned(true),
    onUnpin: () => void session.setPinned(false),
    onRename: handleRename,
    onArchive: handleArchive,
    onReconnect: undefined,
    onConvertAutomation: undefined,
    onDelete: handleDelete,
  };

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
            <span
              className={cn(
                'min-w-0 truncate text-left transition-colors',
                session.isBootstrapping && 'text-foreground/40'
              )}
            >
              {sessionName}
            </span>
          </SidebarMenuAction>
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

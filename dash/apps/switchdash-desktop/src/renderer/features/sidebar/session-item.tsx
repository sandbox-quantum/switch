import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { SessionContextMenu } from '@renderer/features/sessions/components/session-context-menu';
import {
  getSessionManagerStore,
  getSessionStore,
} from '@renderer/features/sessions/stores/session-selectors';
import { SessionSidebarTrailingSlot } from '@renderer/features/sidebar/session-sidebar-agent-status';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { useAppSettingsKey } from '../settings/use-app-settings-key';
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

  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const isActive =
    currentView === 'session' && params.sessionId === sessionId && params.locationId === locationId;

  // A deeplink reveal expands the tree and asks this session's row to center
  // itself; reading the flag in render (not just the effect) lets the row react
  // whether it was already mounted or only just appeared after the expand.
  const rowRef = useRef<HTMLDivElement>(null);
  const shouldScrollIntoView = sidebarStore.pendingScrollSessionId === sessionId;
  useEffect(() => {
    if (!shouldScrollIntoView) return;
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    sidebarStore.clearPendingScroll();
  }, [shouldScrollIntoView]);

  const session = getSessionStore(locationId, sessionId)!;
  const sessionManager = getSessionManagerStore(locationId);

  const sessionName = session.data.title;

  const handleProvision = () => {
    if (session.state !== 'unprovisioned' || session.phase !== 'idle') return;
    void sessionManager?.provisionSession(sessionId);
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

  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;

  return (
    <SessionContextMenu
      isPinned={session.data.isPinned}
      canPin={canPin}
      isArchived={false}
      onPin={() => void session.setPinned(true)}
      onUnpin={() => void session.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={undefined}
      onConvertAutomation={undefined}
      onDelete={handleDelete}
    >
      <SidebarMenuRow
        ref={rowRef}
        className={cn(
          'group/row flex items-center justify-between px-1 h-8 gap-1',
          rowVariant === 'pinned' && 'pl-2'
        )}
        style={rowVariant === 'pinned' ? undefined : depthIndent(depth)}
        isActive={isActive}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openSession}
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
        <div className="ml-2 flex shrink-0 items-center justify-end gap-1.5">
          <SessionSidebarTrailingSlot session={session} showTimestamp={showTimestamps} />
        </div>
      </SidebarMenuRow>
    </SessionContextMenu>
  );
});

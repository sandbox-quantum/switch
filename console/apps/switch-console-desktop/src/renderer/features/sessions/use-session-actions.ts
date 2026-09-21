import type { SessionActionsProps } from '@renderer/features/sessions/components/session-actions';
import {
  getSessionManagerStore,
  getSessionStore,
} from '@renderer/features/sessions/stores/session-selectors';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

/**
 * Pin, rename, archive and delete for one session, wired to the modals and the
 * navigation each of them needs.
 *
 * Shared because the same list is offered from several places — the sidebar
 * row, its right-click menu, the session header — and a copy per surface is how
 * one of them ends up leaving the user on a page for a session it just deleted.
 *
 * Null when the session has no store yet; the caller renders no menu.
 */
export function useSessionActionProps(
  locationId: string,
  sessionId: string
): SessionActionsProps | null {
  const { navigate } = useNavigate();
  const showRename = useShowModal('renameSessionModal');
  const showDeleteSession = useShowModal('deleteSessionModal');
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  const session = getSessionStore(locationId, sessionId);
  const sessionManager = getSessionManagerStore(locationId);
  if (!session) return null;

  const sessionName = session.data.title;
  const isActive =
    currentView === 'session' && params.sessionId === sessionId && params.locationId === locationId;

  return {
    isPinned: session.data.isPinned,
    canPin: session.state !== 'unregistered',
    isArchived: false,
    onPin: () => void session.setPinned(true),
    onUnpin: () => void session.setPinned(false),
    onRename: () => showRename({ locationId, sessionId, currentName: sessionName }),
    onArchive: () => {
      if (isActive) navigate('location', { locationId });
      void sessionManager?.archiveSession(sessionId);
    },
    onReconnect: undefined,
    onConvertAutomation: undefined,
    onDelete: () =>
      showDeleteSession({
        locationId,
        sessions: [{ sessionId, sessionName }],
        onSuccess: () => {
          void sessionManager?.deleteSessions([sessionId]);
          if (isActive) navigate('location', { locationId });
        },
      }),
  };
}

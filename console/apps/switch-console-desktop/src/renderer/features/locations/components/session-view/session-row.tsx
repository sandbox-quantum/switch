import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import { AgentStatusIndicator } from '@renderer/features/sessions/components/agent-status-indicator';
import { SessionContextMenu } from '@renderer/features/sessions/components/session-context-menu';
import {
  getSessionManagerStore,
  sessionAgentStatus,
} from '@renderer/features/sessions/stores/session-selectors';
import { type SessionStore } from '@renderer/features/sessions/stores/session-store';
import { SessionRoomLabel } from '@renderer/features/switch-rooms/session-room-label';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { cn } from '@renderer/utils/utils';
import { type Session } from '@shared/core/sessions/sessions';

export type ReadySession = SessionStore & { data: Session };

export const SessionRow = observer(function SessionRow({
  session,
  isSelected,
  onToggleSelect,
}: {
  session: ReadySession;
  isSelected: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
}) {
  const { navigate } = useNavigate();
  const showRename = useShowModal('renameSessionModal');
  const showDeleteSession = useShowModal('deleteSessionModal');
  const sessionManager = getSessionManagerStore(session.locationId);
  const shiftKeyRef = useRef(false);

  const handleArchive = () => void sessionManager?.archiveSession(session.data.id);
  const handleRestore = () => void sessionManager?.restoreSession(session.data.id);
  const handleProvision = () => void sessionManager?.provisionSession(session.data.id, 'auto');
  const handleDelete = () =>
    showDeleteSession({
      locationId: session.locationId,
      sessions: [{ sessionId: session.data.id, sessionName: session.data.title }],
      onSuccess: () => void sessionManager?.deleteSessions([session.data.id]),
    });
  const handleRename = () =>
    showRename({
      locationId: session.locationId,
      sessionId: session.data.id,
      currentName: session.data.title,
    });
  const isArchived = Boolean(session.data.archivedAt);
  const canPin = session.state !== 'unregistered';
  // Only working still draws something, so only working may take the row's
  // trailing slot from the timestamp.
  const isWorking = sessionAgentStatus(session) === 'working';

  return (
    <SessionContextMenu
      isPinned={session.data.isPinned}
      canPin={canPin}
      isArchived={isArchived}
      onPin={() => void session.setPinned(true)}
      onUnpin={() => void session.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onRestore={handleRestore}
      onConvertAutomation={undefined}
      onDelete={handleDelete}
    >
      <button
        onClick={() => {
          if (isArchived) return;
          handleProvision();
          navigate('session', { locationId: session.locationId, sessionId: session.data.id });
        }}
        className="group flex w-full items-center gap-2 rounded-lg p-3 transition-colors hover:bg-background-1"
      >
        {/* The row's mark and its checkbox share one slot: the checkbox is only
            reachable by pointer, so reserving a column for it beside the mark
            indents every row for a control that is invisible most of the time. */}
        <div className="relative flex size-4 shrink-0 items-center justify-center">
          <MessageSquare
            className={cn(
              'size-4 text-foreground-passive transition-opacity',
              isSelected ? 'opacity-0' : 'group-hover:opacity-0'
            )}
          />
          <div
            onPointerDownCapture={(e) => {
              shiftKeyRef.current = e.shiftKey;
            }}
            onKeyDownCapture={(e) => {
              shiftKeyRef.current = e.shiftKey;
            }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'absolute inset-0 flex items-center justify-center transition-opacity',
              isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => {
                const shift = shiftKeyRef.current;
                shiftKeyRef.current = false;
                onToggleSelect(shift);
              }}
              aria-label="Select session"
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-left text-sm">{session.data.title}</span>
        </div>
        <SessionRoomLabel sessionId={session.data.id} />
        <div
          className={cn(
            'flex min-w-8 shrink-0 items-center justify-end',
            isWorking ? 'justify-end' : 'justify-middle'
          )}
        >
          {isWorking ? (
            <AgentStatusIndicator status="working" />
          ) : (
            <RelativeTime
              value={session.data.createdAt}
              className="pr-1 font-mono text-xs text-foreground-passive"
              compact
            />
          )}
        </div>
      </button>
    </SessionContextMenu>
  );
});

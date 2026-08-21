import { useHotkey } from '@tanstack/react-hotkeys';
import { Archive, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { ListPopoverCard } from '@renderer/lib/components/list-popover-card';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { SessionRow, type ReadySession } from './session-row';

function SelectionBar({
  count,
  tab,
  onClear,
  onArchive,
  onRestore,
  onDelete,
}: {
  count: number;
  tab: 'active' | 'archived';
  onClear: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  if (count === 0) return null;

  return (
    <ListPopoverCard className="justify-between">
      <span className="whitespace-nowrap text-foreground-muted">{count} selected</span>
      <div className="flex items-center gap-2">
        {tab === 'active' && (
          <Button variant="outline" size="sm" onClick={onArchive}>
            <Archive className="size-3.5" />
            Archive
          </Button>
        )}
        {tab === 'archived' && (
          <Button variant="outline" size="sm" onClick={onRestore}>
            <RotateCcw className="size-3.5" />
            Restore
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          Delete <BoundShortcut settingsKey="deleteSelectedSessions" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClear} aria-label="Clear selection">
          <X className="size-3.5" />
        </Button>
      </div>
    </ListPopoverCard>
  );
}

export const SessionList = observer(function SessionList() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const store = asMounted(getLocationStore(locationId));
  const sessionManager = getSessionManagerStore(locationId);
  const showDeleteSession = useShowModal('deleteSessionModal');
  const showCreateSessionModal = useShowModal('sessionModal');

  const sessionView = store?.view.sessionView ?? null;

  const allSessions = sessionManager
    ? Array.from(sessionManager.sessions.values())
        .filter((t): t is ReadySession => t.state !== 'unregistered')
        // Scope to the active subagent: its own page lists only sessions
        // launched as it; the parent agent's page excludes subagent sessions.
        .filter((t) => (agentName ? t.data.agentName === agentName : !t.data.agentName))
    : [];
  const activeSessions = allSessions.filter((t) => !t.data.archivedAt);
  const archivedSessions = allSessions.filter((t) => Boolean(t.data.archivedAt));

  const clearSelection = () => sessionView?.setSelectedIds(new Set());

  const bulkArchive = () => {
    if (!sessionView) return;

    const ids = [...sessionView.selectedIds];
    ids.forEach((id) => void sessionManager?.archiveSession(id));
    clearSelection();
  };

  const bulkRestore = () => {
    if (!sessionView) return;

    const ids = [...sessionView.selectedIds];
    ids.forEach((id) => void sessionManager?.restoreSession(id));
    clearSelection();
  };

  const bulkDelete = () => {
    if (!sessionView) return;
    if (sessionView.selectedIds.size === 0) return;

    const selectedSessions = [...sessionView.selectedIds]
      .map((id) => sessionManager?.sessions.get(id))
      .filter((t): t is ReadySession => !!t)
      .map((t) => ({ sessionId: t.data.id, sessionName: t.data.title }));

    if (selectedSessions.length === 0) return;

    showDeleteSession({
      locationId,
      sessions: selectedSessions,
      onSuccess: () => {
        void sessionManager?.deleteSessions([...sessionView.selectedIds]);
        clearSelection();
      },
    });
  };

  useHotkey(
    getHotkeyRegistration('deleteSelectedSessions'),
    (e) => {
      e.preventDefault();
      bulkDelete();
    },
    {
      enabled:
        (sessionView?.selectedIds.size ?? 0) > 0 &&
        !modalStore.isOpen &&
        getEffectiveHotkey('deleteSelectedSessions') !== null,
      ignoreInputs: true,
    }
  );

  if (!sessionView) return null;

  const showingArchived = sessionView.tab === 'archived';
  const displaySessions = showingArchived ? archivedSessions : activeSessions;

  return (
    <section className="relative flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Sessions</SectionLabel>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New session"
          onClick={() =>
            showCreateSessionModal({ locationId, agentName, entryPoint: 'session_list' })
          }
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {displaySessions.length === 0 && !showingArchived ? (
        // No call to action here: New Session sits at the top of the page and
        // again beside this heading, so a third one would be the loudest thing
        // on an empty section.
        <p className="py-2 text-sm text-foreground-muted">No sessions yet.</p>
      ) : (
        <div className="-mx-3 flex flex-col">
          {displaySessions.map((session) => (
            <SessionRow
              key={session.data.id}
              session={session}
              isSelected={sessionView.selectedIds.has(session.data.id)}
              onToggleSelect={(shiftKey) => {
                if (shiftKey) {
                  sessionView.selectRange(
                    displaySessions.map((t) => t.data.id),
                    session.data.id
                  );
                } else {
                  sessionView.toggleSelect(session.data.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Archiving is otherwise a one-way door: with no way back to an archived
        session, Archive and Delete would look like the same action. One quiet
        line, and only when there is something behind it. */}
      {archivedSessions.length > 0 && (
        <button
          type="button"
          className="-mx-1 w-fit cursor-pointer rounded px-1 py-1 text-xs text-foreground-muted underline underline-offset-2 transition-colors hover:bg-background-1 hover:text-foreground"
          onClick={() => {
            clearSelection();
            sessionView.setTab(showingArchived ? 'active' : 'archived');
          }}
        >
          {showingArchived
            ? 'Back to active sessions'
            : `${archivedSessions.length} archived ${archivedSessions.length === 1 ? 'session' : 'sessions'}`}
        </button>
      )}

      <SelectionBar
        count={sessionView.selectedIds.size}
        tab={sessionView.tab}
        onClear={clearSelection}
        onArchive={bulkArchive}
        onRestore={bulkRestore}
        onDelete={bulkDelete}
      />
    </section>
  );
});

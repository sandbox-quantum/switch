import { useHotkey } from '@tanstack/react-hotkeys';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, RotateCcw, Trash2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { ListPopoverCard } from '@renderer/lib/components/list-popover-card';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { cn } from '@renderer/utils/utils';
import { SessionListEmptyState } from './session-list-empty-state';
import { SessionRow, type ReadySession } from './session-row';

function SessionVirtualList({
  sessions,
  selectedIds,
  onToggleSelect,
}: {
  sessions: ReadySession[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const virtualItems = virtualizer.getVirtualItems();

  if (sessions.length === 0) {
    return <EmptyState label="No sessions" description="No sessions found" />;
  }

  return (
    <div
      ref={parentRef}
      className="min-h-0 flex-1 overflow-y-auto py-3"
      style={{ scrollbarWidth: 'none' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualItem) => {
          const session = sessions[virtualItem.index]!;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className={cn(virtualItem.index === sessions.length - 1 && 'border-b-0')}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <SessionRow
                session={session}
                isSelected={selectedIds.has(session.data.id)}
                onToggleSelect={(shiftKey) => onToggleSelect(session.data.id, shiftKey)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
  const { value: keyboard } = useAppSettingsKey('keyboard');

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
    getHotkeyRegistration('deleteSelectedSessions', keyboard),
    (e) => {
      e.preventDefault();
      bulkDelete();
    },
    {
      enabled:
        (sessionView?.selectedIds.size ?? 0) > 0 &&
        !modalStore.isOpen &&
        getEffectiveHotkey('deleteSelectedSessions', keyboard) !== null,
      ignoreInputs: true,
    }
  );

  if (!sessionView) return null;

  const displaySessions = sessionView.tab === 'active' ? activeSessions : archivedSessions;
  const q = sessionView.searchQuery.trim().toLowerCase();
  const filteredSessions = q
    ? displaySessions.filter((t) => t.data.title.toLowerCase().includes(q))
    : displaySessions;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 flex-col gap-4 border-b border-border pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            multiple={false}
            value={[sessionView.tab]}
            onValueChange={([value]) => {
              if (value) sessionView.setTab(value as 'active' | 'archived');
            }}
          >
            <ToggleGroupItem value="active">Active ({activeSessions.length})</ToggleGroupItem>
            <ToggleGroupItem value="archived">Archived ({archivedSessions.length})</ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <SearchInput
              placeholder="Search sessions…"
              value={sessionView.searchQuery}
              onChange={(e) => sessionView.setSearchQuery(e.target.value)}
              className="flex-1"
            />
            <Button onClick={() => showCreateSessionModal({ locationId, agentName })}>
              Create Session <BoundShortcut settingsKey="newSession" />
            </Button>
          </div>
        </div>
      </div>

      {filteredSessions.length === 0 && sessionView.tab === 'active' ? (
        <SessionListEmptyState locationId={locationId} agentName={agentName} />
      ) : (
        <SessionVirtualList
          sessions={filteredSessions}
          selectedIds={sessionView.selectedIds}
          onToggleSelect={(id, shiftKey) => {
            if (shiftKey) {
              sessionView.selectRange(
                filteredSessions.map((t) => t.data.id),
                id
              );
            } else {
              sessionView.toggleSelect(id);
            }
          }}
        />
      )}

      <SelectionBar
        count={sessionView.selectedIds.size}
        tab={sessionView.tab}
        onClear={clearSelection}
        onArchive={bulkArchive}
        onRestore={bulkRestore}
        onDelete={bulkDelete}
      />
    </div>
  );
});

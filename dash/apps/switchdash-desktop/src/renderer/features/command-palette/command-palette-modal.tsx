import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Activity, File, FolderOpen, GitBranch, type LucideIcon } from 'lucide-react';
import { useObserver } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getSessionStore } from '@renderer/features/sessions/stores/session-selectors';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { ALL_COMMAND_DEFS, type CommandDef } from '@shared/commands';
import type { SearchItem } from '@shared/core/search';
import { getCommandIcon } from './command-icons';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { PaletteNotificationsGroup } from './palette-notifications-group';
import { PaletteProjectsGroup } from './palette-projects-group';
import { PaletteSessionItem } from './palette-session-item';
import { ResourceMonitorView } from './resource-monitor-view';
import { applyContextAffinity } from './search-utils';

interface CommandPaletteProps {
  projectId?: string;
  sessionId?: string;
  workspaceId?: string;
}

interface PaletteAction {
  kind: 'action';
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: ReturnType<typeof getEffectiveHotkey>;
  icon?: LucideIcon;
  execute: () => void;
}

const KIND_ICON: Record<string, React.ReactNode> = {
  action: null,
  session: <GitBranch size={14} className="shrink-0 text-foreground/40" />,
  project: <FolderOpen size={14} className="shrink-0 text-foreground/40" />,
};

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

// Ordered allowlists for the "Suggested Actions" empty-state group. Defined at
// module scope so the arrays keep stable references across renders.
const SESSION_SUGGESTED = [
  'session.sidebarChanges',
  'session.sidebarFiles',
  'session.sidebarConversations',
  'session.toggleTerminalDrawer',
  'resource-monitor',
  'app.giveFeedback',
];
const PROJECT_SUGGESTED = [
  'app.newSession',
  'app.settings',
  'resource-monitor',
  'app.giveFeedback',
];
const APP_SUGGESTED = ['app.newProject', 'app.settings', 'resource-monitor', 'app.giveFeedback'];

function PaletteItem({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: SearchItem | PaletteAction;
  onSelect: () => void;
}) {
  const action = item.kind === 'action' ? (item as PaletteAction) : null;
  const ActionIcon = action?.icon;
  const iconNode = ActionIcon ? (
    <ActionIcon size={14} className="shrink-0 text-foreground/40" />
  ) : (
    KIND_ICON[item.kind]
  );
  return (
    <Command.Item value={value} onSelect={onSelect} className={cn(PALETTE_ITEM_CLASS, 'group')}>
      {iconNode}
      <span className="flex-1 truncate">{item.title}</span>
      {action?.shortcut && (
        <>
          <Shortcut hotkey={action.shortcut} className="group-aria-selected:hidden" />
          <Shortcut
            hotkey={action.shortcut}
            variant="badge"
            className="hidden group-aria-selected:inline-flex"
          />
        </>
      )}
    </Command.Item>
  );
}

function PaletteFileItem({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: SearchItem;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      <File className="size-3.5 shrink-0 text-foreground/60" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="shrink-0">{item.title}</span>
        <span className="truncate text-xs text-foreground/40">{item.subtitle}</span>
      </span>
    </Command.Item>
  );
}

export function CommandPaletteModal({
  projectId,
  sessionId,
  workspaceId,
  onClose,
}: CommandPaletteProps & BaseModalProps) {
  const [view, setView] = useState<'search' | 'resource-monitor'>('search');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 100);
  const { navigate } = useNavigate();
  const { value: resourceMonitor } = useAppSettingsKey('resourceMonitor');
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const queryClient = useQueryClient();

  const handleClose = onClose;

  useEffect(() => {
    if (view !== 'resource-monitor') return;
    appState.resourceMonitor.start();
    return () => appState.resourceMonitor.dispose();
  }, [view]);

  // Prefetch recents immediately on mount so the empty-query view is instant.
  useEffect(() => {
    void queryClient.prefetchQuery({
      queryKey: ['cmdk-search', '', projectId, sessionId, workspaceId],
      queryFn: () =>
        rpc.search.commandPalette({ query: '', context: { projectId, sessionId, workspaceId } }),
      staleTime: 5_000,
    });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const { data: dbResults = [] } = useQuery({
    queryKey: ['cmdk-search', debouncedQuery, projectId, sessionId, workspaceId],
    queryFn: () =>
      rpc.search.commandPalette({
        query: debouncedQuery,
        context: { projectId, sessionId, workspaceId },
      }),
    // Keep results fresh for 5 s — re-opening the palette with the same query
    // returns cached data instantly rather than waiting for a round-trip.
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    // Skip FTS queries that the trigram tokenizer would reject (< 3 chars).
    enabled: debouncedQuery.length === 0 || debouncedQuery.length >= 3,
  });

  const registryActions = useObserver((): PaletteAction[] =>
    commandRegistry.activeCommands
      .filter((cmd) => cmd.enabled !== false && !cmd.hideFromPalette)
      .map((cmd) => {
        const def = ALL_COMMAND_DEFS.find((d) => d.id === cmd.id) as CommandDef | undefined;
        return {
          kind: 'action' as const,
          id: cmd.id,
          title: cmd.label,
          subtitle: cmd.description,
          shortcut: cmd.shortcutKey ? getEffectiveHotkey(cmd.shortcutKey, keyboard) : null,
          icon: getCommandIcon(def?.iconKey),
          execute: () => {
            handleClose();
            cmd.execute();
          },
        };
      })
  );

  const resourceMonitorAction = useMemo<PaletteAction | null>(
    () =>
      resourceMonitor?.enabled
        ? {
            kind: 'action',
            id: 'resource-monitor',
            title: 'Resource Monitor',
            subtitle: 'Show CPU and memory performance for running agents',
            icon: Activity,
            execute: () => {
              setView('resource-monitor');
            },
          }
        : null,
    [resourceMonitor?.enabled]
  );

  const actions = useMemo(() => {
    // Empty state: show the ordered context-specific suggested actions only.
    const suggestedIds = sessionId
      ? SESSION_SUGGESTED
      : projectId
        ? PROJECT_SUGGESTED
        : APP_SUGGESTED;
    const pool = resourceMonitorAction
      ? [...registryActions, resourceMonitorAction]
      : registryActions;
    return pool
      .filter((a) => suggestedIds.includes(a.id))
      .sort((a, b) => suggestedIds.indexOf(a.id) - suggestedIds.indexOf(b.id))
      .slice(0, 7);
  }, [registryActions, resourceMonitorAction, projectId, sessionId]);

  const rankedDb = applyContextAffinity(dbResults, { projectId });
  const actionResults = actions;

  const q = debouncedQuery.toLowerCase();
  const matchedResourceMonitor =
    resourceMonitorAction &&
    q &&
    (resourceMonitorAction.title.toLowerCase().includes(q) ||
      resourceMonitorAction.subtitle?.toLowerCase().includes(q))
      ? resourceMonitorAction
      : null;
  const sessionResults = rankedDb.filter((r): r is SearchItem => r.kind === 'session');

  const handleNavigateToSession = (item: SearchItem) => {
    if (!item.projectId) return;
    handleClose();
    navigate('session', { projectId: item.projectId, sessionId: item.id });
  };

  const handleNavigateToProject = (item: SearchItem) => {
    handleClose();
    navigate('project', { projectId: item.id });
  };

  const handleOpenFile = (item: SearchItem) => {
    if (!item.projectId || !item.sessionId) return;
    handleClose();
    navigate('session', { projectId: item.projectId, sessionId: item.sessionId });
  };

  const handleSelect = (item: SearchItem) => {
    if (item.kind === 'session') return handleNavigateToSession(item);
    if (item.kind === 'project') return handleNavigateToProject(item);
    if (item.kind === 'file') return handleOpenFile(item);
  };

  const handleResourceMonitorBack = useCallback(() => {
    setView('search');
  }, []);

  useEffect(() => {
    if (view !== 'resource-monitor') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        handleResourceMonitorBack();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [view, handleResourceMonitorBack]);

  if (view === 'resource-monitor') {
    return (
      <div className="flex flex-col overflow-hidden">
        <ResourceMonitorView onBack={handleResourceMonitorBack} />
        <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2">
          <span className="flex items-center gap-1 text-xs text-foreground/40">
            <Shortcut hotkey="Escape" variant="badge" />
            <Shortcut hotkey="Backspace" variant="badge" />
            Back
          </span>
        </div>
      </div>
    );
  }

  return (
    <Command className="flex flex-col overflow-hidden" shouldFilter={false} loop>
      <div className="border-b border-foreground/10 px-1">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search sessions, projects, actions…"
          className="w-full bg-transparent px-3 py-3 text-sm outline-none placeholder:text-foreground/40"
          autoFocus
        />
      </div>
      <Command.List className="h-96 overflow-y-auto p-1">
        {query ? (
          <>
            <Command.Empty className="py-8 text-center text-sm text-foreground/40">
              No results for &ldquo;{query}&rdquo;
            </Command.Empty>
            {matchedResourceMonitor && (
              <PaletteItem
                value={matchedResourceMonitor.id}
                item={matchedResourceMonitor}
                onSelect={matchedResourceMonitor.execute}
              />
            )}
            {rankedDb.map((item) => {
              if (item.kind === 'command') {
                const live = commandRegistry.findById(item.id);
                if (!live || live.enabled === false || live.hideFromPalette) return null;
                const def = ALL_COMMAND_DEFS.find((d) => d.id === item.id) as
                  | CommandDef
                  | undefined;
                const shortcut = def?.shortcutKey
                  ? getEffectiveHotkey(def.shortcutKey, keyboard)
                  : null;
                const displayItem: PaletteAction = {
                  kind: 'action',
                  id: item.id,
                  title: live.label,
                  subtitle: live.description,
                  shortcut,
                  icon: getCommandIcon(def?.iconKey),
                  execute: () => {
                    handleClose();
                    live.execute();
                  },
                };
                return (
                  <PaletteItem
                    key={item.id}
                    value={item.id}
                    item={displayItem}
                    onSelect={() => {
                      handleClose();
                      live.execute();
                    }}
                  />
                );
              }
              if (item.kind === 'session' && item.projectId) {
                const store = getSessionStore(item.projectId, item.id);
                if (store) {
                  return (
                    <PaletteSessionItem
                      key={`session:${item.id}`}
                      sessionStore={store}
                      value={`session:${item.id}`}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  );
                }
              }
              if (item.kind === 'file') {
                return (
                  <PaletteFileItem
                    key={`file:${item.id}`}
                    value={`file:${item.id}`}
                    item={item}
                    onSelect={() => handleOpenFile(item)}
                  />
                );
              }
              return (
                <PaletteItem
                  key={`${item.kind}:${item.id}`}
                  value={`${item.kind}:${item.id}`}
                  item={item}
                  onSelect={() => handleSelect(item)}
                />
              );
            })}
          </>
        ) : (
          <>
            <PaletteNotificationsGroup
              currentProjectId={projectId}
              currentSessionId={sessionId}
              onClose={handleClose}
              navigate={navigate}
            />
            {actionResults.length > 0 && (
              <Command.Group heading="Suggested Actions" className={GROUP_CLASS}>
                {actionResults.map((item) => (
                  <PaletteItem key={item.id} value={item.id} item={item} onSelect={item.execute} />
                ))}
              </Command.Group>
            )}
            {sessionResults.length > 0 && (
              <Command.Group heading="Recent Sessions" className={GROUP_CLASS}>
                {sessionResults.slice(0, 5).map((item) => {
                  const store = item.projectId
                    ? getSessionStore(item.projectId, item.id)
                    : undefined;
                  return store ? (
                    <PaletteSessionItem
                      key={item.id}
                      sessionStore={store}
                      value={item.id}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  ) : (
                    <PaletteItem
                      key={item.id}
                      value={item.id}
                      item={item}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  );
                })}
              </Command.Group>
            )}
            {!sessionId && (
              <PaletteProjectsGroup
                currentProjectId={projectId}
                limit={5}
                onClose={handleClose}
                navigate={navigate}
              />
            )}
          </>
        )}
      </Command.List>

      <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2">
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="ArrowUp" variant="badge" />
          <Shortcut hotkey="ArrowDown" variant="badge" />
          Navigate
        </span>
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="Enter" variant="badge" />
          Select
        </span>
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="Escape" variant="badge" />
          Close
        </span>
      </div>
    </Command>
  );
}

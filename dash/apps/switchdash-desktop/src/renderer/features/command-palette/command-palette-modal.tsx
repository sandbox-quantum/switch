import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  Activity,
  Bot,
  DoorOpen,
  Globe,
  HardDrive,
  type LucideIcon,
  MessageSquare,
  Server,
} from 'lucide-react';
import { observer, useObserver } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { REMOTE_HOSTS_QUERY_KEY } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { getSessionStore } from '@renderer/features/sessions/stores/session-selectors';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { agentExpandKey } from '@renderer/features/sidebar/agent-item';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { scopeToLocationServer, scopeToRoomServer } from '@renderer/lib/layout/scope-to-server';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { ALL_COMMAND_DEFS, type CommandDef } from '@shared/commands';
import type { SearchItem, SearchResult } from '@shared/core/search';
import { getCommandIcon } from './command-icons';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { PaletteNotificationsGroup } from './palette-notifications-group';
import { PaletteSessionItem } from './palette-session-item';
import { ResourceMonitorView } from './resource-monitor-view';
import { applyContextAffinity, matchHosts, matchRooms, matchServers } from './search-utils';

interface CommandPaletteProps {
  locationId?: string;
  sessionId?: string;
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

const MUTED_ICON = 'size-3.5 shrink-0 text-foreground/40';

/**
 * The icon a result carries in the left sidebar.
 *
 * Deliberately not a static kind→glyph map: the sidebar's icons are conditional
 * — an agent shows its provider's mark, a room its bridge platform, a server its
 * management kind — so a flat map can only ever approximate them. Resolving from
 * the same stores the sidebar reads keeps the two in step instead of leaving a
 * second set of lookalikes to drift.
 */
const PaletteKindIcon = observer(function PaletteKindIcon({ item }: { item: SearchItem }) {
  switch (item.kind) {
    case 'agent': {
      const providerId = agentsStore.agentById(item.id)?.providerId;
      return providerId ? (
        <AgentIcon id={providerId} size={14} className="shrink-0" />
      ) : (
        <Bot className={MUTED_ICON} />
      );
    }
    case 'room': {
      const bridgeType = switchRoomsStore.roomBridgeTypeById(item.id);
      return hasBridgeIcon(bridgeType) ? (
        <BridgeIcon bridgeType={bridgeType} size={14} className="size-3.5 shrink-0" />
      ) : (
        <DoorOpen className={MUTED_ICON} />
      );
    }
    case 'server': {
      const server = switchServersStore.servers.find((s) => s.id === item.id);
      if (server?.managementKind === 'remote') return <Server className={MUTED_ICON} />;
      return server?.managed ? (
        <HardDrive className={MUTED_ICON} />
      ) : (
        <Globe className={MUTED_ICON} />
      );
    }
    case 'host':
      return <Server className={MUTED_ICON} />;
    case 'session':
      return <MessageSquare className={MUTED_ICON} />;
    default:
      return null;
  }
});

/** Stable identity for the un-fetched state, so the default does not create a
 *  new object on every render and retrigger downstream memos. */
const EMPTY_RESULT: SearchResult = { items: [], status: 'recents' };

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
  'session.toggleTerminalDrawer',
  'resource-monitor',
  'app.giveFeedback',
];
const LOCATION_SUGGESTED = [
  'app.newSession',
  'app.settings',
  'resource-monitor',
  'app.giveFeedback',
];
const APP_SUGGESTED = ['app.newLocation', 'app.settings', 'resource-monitor', 'app.giveFeedback'];

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
  ) : action ? null : (
    <PaletteKindIcon item={item as SearchItem} />
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

/** One group of renderer-matched results, or nothing when the kind had no hits. */
function PaletteResultGroup({
  heading,
  items,
  onSelect,
}: {
  heading: string;
  items: SearchItem[];
  onSelect: (item: SearchItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Command.Group heading={heading} className={GROUP_CLASS}>
      {items.map((item) => (
        <PaletteItem
          key={`${item.kind}:${item.id}`}
          value={`${item.kind}:${item.id}`}
          item={item}
          onSelect={() => onSelect(item)}
        />
      ))}
    </Command.Group>
  );
}

export function CommandPaletteModal({
  locationId,
  sessionId,
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
      queryKey: ['cmdk-search', '', locationId, sessionId],
      queryFn: () => rpc.search.commandPalette({ query: '', context: { locationId, sessionId } }),
      staleTime: 5_000,
    });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const { data: searchResult = EMPTY_RESULT } = useQuery({
    queryKey: ['cmdk-search', debouncedQuery, locationId, sessionId],
    queryFn: () =>
      rpc.search.commandPalette({
        query: debouncedQuery,
        context: { locationId, sessionId },
      }),
    // Keep results fresh for 5 s — re-opening the palette with the same query
    // returns cached data instantly rather than waiting for a round-trip.
    staleTime: 5_000,
    placeholderData: (prev) => prev,
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
      : locationId
        ? LOCATION_SUGGESTED
        : APP_SUGGESTED;
    const pool = resourceMonitorAction
      ? [...registryActions, resourceMonitorAction]
      : registryActions;
    return pool
      .filter((a) => suggestedIds.includes(a.id))
      .sort((a, b) => suggestedIds.indexOf(a.id) - suggestedIds.indexOf(b.id))
      .slice(0, 7);
  }, [registryActions, resourceMonitorAction, locationId, sessionId]);

  const rankedDb = applyContextAffinity(searchResult.items, { locationId });
  const actionResults = actions;

  // Rooms and servers come from MobX stores rather than the FTS index, read
  // through useObserver so a background refresh reaches an open palette. Rooms
  // span every server, not the active one: you search precisely because you do
  // not know where a thing is.
  const roomResults = useObserver(() =>
    matchRooms(switchRoomsStore.listedRoomsOnAllServers, debouncedQuery)
  );
  const serverResults = useObserver(() => matchServers(switchServersStore.servers, debouncedQuery));

  const { data: hosts = [] } = useQuery({
    queryKey: REMOTE_HOSTS_QUERY_KEY,
    queryFn: () => rpc.remoteHosts.listHosts(),
    staleTime: 30_000,
  });
  const hostResults = matchHosts(hosts, debouncedQuery);
  const rendererMatchCount = roomResults.length + serverResults.length + hostResults.length;

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
    if (!item.locationId) return;
    const locationId = item.locationId;
    handleClose();
    void scopeToLocationServer(locationId).then(() =>
      navigate('session', { locationId, sessionId: item.id })
    );
  };

  /**
   * Opens the agent, matching `sidebar/agent-item.tsx` exactly.
   *
   * `agentName` is what selects the agent — without it the location view falls
   * back to its first agent, so the palette would open a different agent than
   * the one that was picked. Expanding the group is the sidebar's other half:
   * it is what makes the agent visible in the tree on arrival.
   */
  const handleNavigateToAgent = (item: SearchItem) => {
    if (!item.locationId) return;
    const locationId = item.locationId;
    handleClose();
    void scopeToLocationServer(locationId).then(() => {
      sidebarStore.ensureGroupExpanded(agentExpandKey(item.id));
      navigate('location', { locationId, agentName: item.title });
    });
  };

  const handleNavigateToRoom = (item: SearchItem) => {
    handleClose();
    void scopeToRoomServer(item.id).then(() => navigate('room', { roomId: item.id }));
  };

  const handleNavigateToServer = (item: SearchItem) => {
    handleClose();
    void switchServersStore
      .setActive(item.id)
      .then(() => navigate('server', { serverId: item.id }));
  };

  const handleNavigateToHost = (item: SearchItem) => {
    handleClose();
    navigate('remoteHost', { sshHost: item.id });
  };

  const handleSelect = (item: SearchItem) => {
    if (item.kind === 'session') return handleNavigateToSession(item);
    if (item.kind === 'agent') return handleNavigateToAgent(item);
    if (item.kind === 'room') return handleNavigateToRoom(item);
    if (item.kind === 'server') return handleNavigateToServer(item);
    if (item.kind === 'host') return handleNavigateToHost(item);
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
          placeholder="Search agents, sessions, rooms, servers, actions…"
          className="w-full bg-transparent px-3 py-3 text-sm outline-none placeholder:text-foreground/40"
          autoFocus
        />
      </div>
      <Command.List className="h-96 overflow-y-auto p-1">
        {query ? (
          <>
            {searchResult.status === 'ok' && rendererMatchCount === 0 && (
              <Command.Empty className="py-8 text-center text-sm text-foreground/40">
                No results for &ldquo;{query}&rdquo;
              </Command.Empty>
            )}
            {searchResult.status === 'failed' && (
              <div className="text-destructive px-3 py-6 text-center text-sm">
                Search failed for &ldquo;{query}&rdquo;. This is an error, not an empty result — see
                the log for details.
              </div>
            )}
            {searchResult.status === 'query-too-short' && (
              <div className="px-3 py-6 text-center text-sm text-foreground/40">
                Type at least 3 characters to search agents, sessions and commands.
                {rendererMatchCount > 0 &&
                  ' Rooms, servers and hosts are matched from the first character.'}
              </div>
            )}
            <PaletteResultGroup
              heading="Rooms"
              items={roomResults}
              onSelect={handleNavigateToRoom}
            />
            <PaletteResultGroup
              heading="Servers"
              items={serverResults}
              onSelect={handleNavigateToServer}
            />
            <PaletteResultGroup
              heading="Remote hosts"
              items={hostResults}
              onSelect={handleNavigateToHost}
            />
            {matchedResourceMonitor && (
              <PaletteItem
                value={matchedResourceMonitor.id}
                item={matchedResourceMonitor}
                onSelect={matchedResourceMonitor.execute}
              />
            )}
            {/* Only when the items actually answer the query. Under any other
                status they are recents or nothing, and rendering them here is
                what made a too-short query look like a result set. */}
            {searchResult.status === 'ok' &&
              rankedDb.map((item) => {
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
                if (item.kind === 'session' && item.locationId) {
                  const store = getSessionStore(item.locationId, item.id);
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
              currentLocationId={locationId}
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
                  const store = item.locationId
                    ? getSessionStore(item.locationId, item.id)
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

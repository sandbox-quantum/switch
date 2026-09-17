import type { AgentInstallationStatus } from '@shared/core/providers/agent-payload';
import { defineEvent } from '@shared/lib/ipc/events';
import type { TabNavigationDirection } from '@shared/shortcuts';

// App editing actions (renderer → main, no payload)
export const appUndoChannel = defineEvent<void>('app:undo');
export const appRedoChannel = defineEvent<void>('app:redo');
export const appPasteChannel = defineEvent<void>('app:paste');

// Menu events (main → renderer, no payload)
export const menuOpenSettingsChannel = defineEvent<void>('menu:open-settings');
export const menuCheckForUpdatesChannel = defineEvent<void>('menu:check-for-updates');
export const menuUndoChannel = defineEvent<void>('menu:undo');
export const menuRedoChannel = defineEvent<void>('menu:redo');
export const menuQuitRequestedChannel = defineEvent<void>('menu:quit-requested');

export const externalLinkOpenRequestedChannel = defineEvent<{ url: string }>(
  'external-link:open-requested'
);

/**
 * An agent row was created, updated or deleted in the main process
 * (main → renderer). Bridges the main-only `agentEvents` bus so renderer
 * stores and queries can react to agent CRUD from any path — Add Agent,
 * Load existing agents, Remove agent — without each call site having to
 * remember a manual refetch (CHOO-2560).
 */
export const agentsChangedChannel = defineEvent<{ kind: 'created' | 'updated' | 'deleted' }>(
  'agents:changed'
);

/**
 * A mouse back/forward button pressed on Windows, where those buttons arrive as
 * an `app-command` on the window rather than as a mouse event in the page.
 * Elsewhere the renderer sees them directly and this never fires.
 */
export const appCommandNavigateChannel = defineEvent<{ direction: 'back' | 'forward' }>(
  'app-command:navigate'
);

export const tabNavigationShortcutChannel = defineEvent<{
  source: { kind: 'browser'; browserId: string };
  direction: TabNavigationDirection;
}>('tab-navigation:shortcut');

export const notificationFocusSessionChannel = defineEvent<{
  agentId: string;
  sessionId: string;
}>('notification:focus-session');

/** Emitted when an agent installation status changes (probe, install, update, or selection change). */
export const agentInstallationStatusUpdatedChannel = defineEvent<AgentInstallationStatus>(
  'agent:installation-status-updated'
);

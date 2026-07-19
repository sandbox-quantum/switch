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
export const menuGiveFeedbackChannel = defineEvent<void>('menu:give-feedback');

export const externalLinkOpenRequestedChannel = defineEvent<{ url: string }>(
  'external-link:open-requested'
);

export const tabNavigationShortcutChannel = defineEvent<{
  source: { kind: 'browser'; browserId: string };
  direction: TabNavigationDirection;
}>('tab-navigation:shortcut');

export const notificationFocusSessionChannel = defineEvent<{
  projectId: string;
  sessionId: string;
}>('notification:focus-session');

export const ptyStartedChannel = defineEvent<{
  id: string;
}>('pty:started');

export type PlanEvent = {
  type: 'write_blocked' | 'remove_blocked';
  root: string;
  relPath: string;
  code?: string;
  message?: string;
};

export const planEventChannel = defineEvent<PlanEvent>('plan:event');

export const ptyDataChannel = defineEvent<string>('pty:data');

export const ptyExitChannel = defineEvent<{
  exitCode: number;
  signal?: number;
}>('pty:exit');

/** Emitted by main process when a PTY is definitively killed (e.g. on deleteSession). */
export const ptyKilledChannel = defineEvent<{ id: string }>('pty:killed');

/** Emitted by main process when a lifecycle/dev-server shell session is created.
 *  These sessions are standalone PTYs — they are NOT backed by a sessions-table row.
 *  The renderer uses sessionId to connect to the PTY terminal.
 */
export const shellSessionStartedChannel = defineEvent<{
  sessionId: string;
  /** Opaque UUID identifying this PTY session — not a sessions-table id. */
  ptySessionId: string;
  ptyId: string;
  title: string;
}>('shell:session-started');

/** Emitted when an agent installation status changes (probe, install, update, or selection change). */
export const agentInstallationStatusUpdatedChannel = defineEvent<AgentInstallationStatus>(
  'agent:installation-status-updated'
);

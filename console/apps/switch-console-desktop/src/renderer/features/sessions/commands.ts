import {
  getRegisteredSessionData,
  getSessionStore,
} from '@renderer/features/sessions/stores/session-selectors';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { SESSION_COMMAND_DEFS, type CommandDef, type SessionCommandId } from '@shared/commands';

function sessionDef(id: SessionCommandId): CommandDef {
  return SESSION_COMMAND_DEFS.find((d) => d.id === id)!;
}

/**
 * CommandProvider for the session (session) scope. Switch Console sessions are a single
 * terminal, so the rich Switch Console session commands (tabs, splits, diff, browser, git,
 * sidebar panels, terminal drawer) are gone — only pin and prev/next remain.
 */
export function createSessionCommandProvider(
  locationId: string,
  sessionId: string
): CommandProvider {
  return {
    scopeId: 'session',

    getCommands() {
      const sessionStore = getSessionStore(locationId, sessionId);
      if (sessionStore?.state !== 'provisioned') return [];

      const sessionData = getRegisteredSessionData(locationId, sessionId);
      const visibleSessionEntries = sidebarStore.visibleSessionEntries;
      const currentIdx = visibleSessionEntries.findIndex(
        (entry) => entry.locationId === locationId && entry.sessionId === sessionId
      );

      const pinDef = sessionDef('session.pin');
      const nextSessionDef = sessionDef('session.nextSession');
      const prevSessionDef = sessionDef('session.prevSession');

      return [
        {
          id: pinDef.id,
          label: sessionData?.isPinned ? 'Unpin Session' : 'Pin Session',
          description: sessionData?.isPinned
            ? 'Remove this session from pinned'
            : 'Pin this session to keep it at the top',
          group: pinDef.group,
          enabled: sessionData != null,
          execute() {
            if (sessionData) void sessionStore?.setPinned(!sessionData.isPinned);
          },
        },
        {
          id: nextSessionDef.id,
          label: nextSessionDef.label,
          description: nextSessionDef.description,
          shortcutKey: nextSessionDef.shortcutKey,
          group: nextSessionDef.group,
          enabled: currentIdx !== -1 && currentIdx < visibleSessionEntries.length - 1,
          hideFromPalette: true,
          execute() {
            const next = visibleSessionEntries[currentIdx + 1];
            if (next) appState.navigation.navigate('session', next);
          },
        },
        {
          id: prevSessionDef.id,
          label: prevSessionDef.label,
          description: prevSessionDef.description,
          shortcutKey: prevSessionDef.shortcutKey,
          group: prevSessionDef.group,
          enabled: currentIdx > 0,
          hideFromPalette: true,
          execute() {
            const previous = visibleSessionEntries[currentIdx - 1];
            if (previous) appState.navigation.navigate('session', previous);
          },
        },
      ];
    },
  };
}

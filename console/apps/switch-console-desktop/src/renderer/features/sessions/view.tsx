import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { type GuardResult, type ViewDefinition } from '@renderer/app/view-registry';
import { SessionViewWrapper } from '@renderer/features/sessions/session-view-context';
import {
  getSessionManagerStore,
  getSessionStore,
  sessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import { appState } from '@renderer/lib/stores/app-state';
import { createSessionCommandProvider } from './commands';
import { SessionMainPanel } from './main-panel';
import { SessionTitlebar } from './session-titlebar';

const SessionViewWrapperWithProviders = observer(function SessionViewWrapperWithProviders({
  children,
  locationId,
  sessionId,
}: {
  children: ReactNode;
  locationId: string;
  sessionId: string;
}) {
  const sessionStore = getSessionStore(locationId, sessionId);
  const kind = sessionViewKind(sessionStore, locationId);

  // Auto-provision when the session view is rendered with an idle session — covers
  // session restore where the session wasn't in openSessionIds, direct navigation,
  // and any other path that lands on the session view before provisioning runs.
  useEffect(() => {
    if (kind !== 'idle') return;
    if (sessionStore && 'archivedAt' in sessionStore.data && sessionStore.data.archivedAt) return;

    getSessionManagerStore(locationId)
      ?.provisionSession(sessionId, 'auto')
      .catch(() => {});
  }, [kind, locationId, sessionId, sessionStore]);

  if (kind !== 'ready') {
    return (
      <SessionViewWrapper locationId={locationId} sessionId={sessionId}>
        {children}
      </SessionViewWrapper>
    );
  }

  return (
    <SessionViewWrapper locationId={locationId} sessionId={sessionId}>
      {children}
    </SessionViewWrapper>
  );
});

export const sessionView = {
  WrapView: SessionViewWrapperWithProviders,
  TitlebarSlot: SessionTitlebar,
  MainPanel: SessionMainPanel,
  commandProvider: ({ locationId, sessionId }: { locationId: string; sessionId: string }) =>
    createSessionCommandProvider(locationId, sessionId),
  canActivate: (params: unknown): GuardResult => {
    const locationId =
      typeof params === 'object' && params !== null
        ? (params as { locationId?: unknown }).locationId
        : undefined;
    const sessionId =
      typeof params === 'object' && params !== null
        ? (params as { sessionId?: unknown }).sessionId
        : undefined;
    if (typeof locationId !== 'string' || typeof sessionId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    if (
      !appState.locations.locations.has(locationId) &&
      !appState.locations.pendingCreationIds.has(locationId)
    ) {
      return { ok: false, redirect: 'home' };
    }
    const sessionManager = getSessionManagerStore(locationId);
    if (sessionManager && !sessionManager.sessions.has(sessionId)) {
      return { ok: false, redirect: 'location', params: { locationId } };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ locationId: string; sessionId: string }>;

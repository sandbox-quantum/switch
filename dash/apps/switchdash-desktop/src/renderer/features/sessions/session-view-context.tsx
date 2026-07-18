import { observer } from 'mobx-react-lite';
import { createContext, useContext, type ReactNode } from 'react';
import { LocationViewWrapper } from '@renderer/features/locations/components/location-view-wrapper';
import type { SessionAgentStore } from '@renderer/features/sessions/stores/session-agent-store';
import {
  getSessionAgent,
  getSessionStore,
  getSessionRuntime,
  sessionViewKind,
  type SessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import type { SessionRuntimeStore } from '@renderer/features/sessions/stores/session-runtime-store';
import type { SessionViewModel } from '@renderer/features/sessions/stores/session-view-model';

interface SessionViewContext {
  locationId: string;
  sessionId: string;
}

const SessionViewContext = createContext<SessionViewContext | null>(null);

export const SessionViewWrapper = observer(function SessionViewWrapper({
  children,
  locationId,
  sessionId,
}: {
  children: ReactNode;
  locationId: string;
  sessionId: string;
}) {
  return (
    <LocationViewWrapper locationId={locationId}>
      <SessionViewContext.Provider value={{ locationId, sessionId }}>
        {children}
      </SessionViewContext.Provider>
    </LocationViewWrapper>
  );
});

export function useSessionViewContext(): SessionViewContext {
  const context = useContext(SessionViewContext);
  if (!context) {
    throw new Error('useSessionViewContext must be used within a SessionViewContextProvider');
  }
  return context;
}

export function useSessionViewKind(): SessionViewKind {
  const { locationId, sessionId } = useSessionViewContext();
  return sessionViewKind(getSessionStore(locationId, sessionId), locationId);
}

/** Returns the active SessionRuntimeStore. Throws if the session is not provisioned. */
export function useSessionRuntime(): SessionRuntimeStore {
  const { locationId, sessionId } = useSessionViewContext();
  const runtime = getSessionRuntime(locationId, sessionId);
  if (!runtime) {
    throw new Error('useSessionRuntime: session is not provisioned (no runtime)');
  }
  return runtime;
}

/** Returns the location id for the active session. */
export function useSessionLocationId(): string {
  const { locationId } = useSessionViewContext();
  return locationId;
}

/** Returns the SessionViewModel. Throws if the session is not registered. */
export function useSessionViewModel(): SessionViewModel {
  const { locationId, sessionId } = useSessionViewContext();
  const viewModel = getSessionStore(locationId, sessionId)?.viewModel;
  if (!viewModel) {
    throw new Error('useSessionViewModel: session is not registered (no view model)');
  }
  return viewModel;
}

/** Returns the SessionAgentStore for the session. Throws if not registered. */
export function useSessionAgent(): SessionAgentStore {
  const { sessionId } = useSessionViewContext();
  const store = getSessionAgent(sessionId);
  if (!store) {
    throw new Error('useSessionAgent: session is not registered (no session-agent store)');
  }
  return store;
}

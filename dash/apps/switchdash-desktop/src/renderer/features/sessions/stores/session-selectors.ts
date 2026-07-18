import { isUnmountedLocation } from '@renderer/features/locations/stores/location';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import type { Session } from '@shared/core/sessions/sessions';
import { sessionAgentRegistry } from './session-agent-registry';
import type { SessionManagerStore } from './session-manager';
import { sessionRuntimeRegistry } from './session-runtime-registry';
import {
  isProvisioned,
  isUnprovisioned,
  isUnregistered,
  registeredSessionData,
  type SessionStore,
} from './session-store';
import type { SessionViewModel } from './session-view-model';

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionManagerStore(locationId: string): SessionManagerStore | undefined {
  const p = getLocationManagerStore().locations.get(locationId);
  return p?.mountedLocation?.sessionManager;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionStore(locationId: string, sessionId: string): SessionStore | undefined {
  return getSessionManagerStore(locationId)?.sessions.get(sessionId);
}

/** Registered session payload (`Session`) when the row exists and is not unregistered; otherwise undefined. */
export function getRegisteredSessionData(
  locationId: string,
  sessionId: string
): Session | undefined {
  const store = getSessionStore(locationId, sessionId);
  if (!store) return undefined;
  return registeredSessionData(store);
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getSessionView(
  locationId: string,
  sessionId: string
): SessionViewModel | undefined {
  return getSessionStore(locationId, sessionId)?.viewModel ?? undefined;
}

export function sessionAgentStatus(store: SessionStore): AgentStatus | null {
  const agent = sessionAgentRegistry.get(store.data.id);
  return agent?.sessionStatus ?? null;
}

export type SessionViewKind =
  | 'missing'
  | 'location-mounting' // location is still opening — session data not yet available
  | 'location-error' // location failed to open
  | 'creating'
  | 'create-error'
  | 'provisioning'
  | 'provision-error'
  | 'teardown'
  | 'teardown-error'
  | 'idle'
  | 'ready';

/**
 * Derives the session view kind from the location + session store state.
 *
 * Pass `locationId` so that "location still opening" can be distinguished from
 * "session genuinely missing". Call only inside `observer` components.
 */
export function sessionViewKind(
  store: SessionStore | undefined,
  locationId: string
): SessionViewKind {
  const locationStore = getLocationManagerStore().locations.get(locationId);

  if (!locationStore) return 'missing';

  if (isUnmountedLocation(locationStore)) {
    if (locationStore.phase === 'opening') return 'location-mounting';
    if (locationStore.phase === 'error') return 'location-error';
    return 'location-mounting';
  }

  if (locationStore.state === 'unregistered') return 'missing';

  if (!store) return 'missing';

  if (isUnregistered(store)) {
    if (store.phase === 'creating') return 'creating';
    return 'create-error';
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision') {
      return 'provisioning';
    }
    if (store.phase === 'provision-error') return 'provision-error';
    if (store.phase === 'teardown') return 'teardown';
    if (store.phase === 'teardown-error') return 'teardown-error';
    return 'idle';
  }
  return 'ready';
}

/** Returns the narrowed provisioned session store if the session is provisioned, otherwise undefined. */
export function asProvisioned(
  store: SessionStore | undefined
): (SessionStore & { state: 'provisioned'; locationId: string }) | undefined {
  return store && isProvisioned(store) ? store : undefined;
}

// ---------------------------------------------------------------------------
// New focused selectors (Phase 4)
// ---------------------------------------------------------------------------

export function getSessionRuntime(locationId: string, sessionId: string) {
  const store = getSessionStore(locationId, sessionId);
  return store ? (sessionRuntimeRegistry.get(locationId) ?? undefined) : undefined;
}

export function getSessionViewModel(
  locationId: string,
  sessionId: string
): SessionViewModel | undefined {
  return getSessionStore(locationId, sessionId)?.viewModel ?? undefined;
}

export function getSessionAgent(sessionId: string) {
  return sessionAgentRegistry.get(sessionId);
}

/** Returns the display name from any session store variant. */
export function sessionDisplayName(store: SessionStore | undefined): string | undefined {
  if (!store) return undefined;
  return store.data.title;
}

/** Returns the error message for error states. */
export function sessionErrorMessage(store: SessionStore | undefined): string | undefined {
  if (!store) return undefined;
  if (isUnregistered(store) && store.phase === 'create-error') {
    return store.errorMessage ?? 'Failed to create session';
  }
  if (isUnprovisioned(store)) {
    if (store.phase === 'provision-error') {
      return store.errorMessage ?? 'Failed to set up workspace';
    }
    if (store.phase === 'teardown-error') {
      return store.errorMessage ?? 'Failed to tear down session';
    }
  }
  return undefined;
}

/** Returns the mount error message for the location. */
export function locationMountErrorMessage(locationId: string): string {
  const store = getLocationManagerStore().locations.get(locationId);
  if (store && isUnmountedLocation(store) && store.phase === 'error') {
    return store.error ?? 'Failed to open location';
  }
  return 'Failed to open location';
}

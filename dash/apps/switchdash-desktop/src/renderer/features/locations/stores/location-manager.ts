import { err, ok } from '@switchdash/shared';
import { makeObservable, observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { type Location } from '@shared/core/locations/locations';
import type { LocationViewSnapshot } from '@shared/view-state';
import type {
  AgentOnboardingCompletion,
  AgentOnboardingError,
  ModeData,
  StartAgentOnboardingOptions,
  StartAgentOnboardingResult,
} from './agent-onboarding-types';
import {
  createUnmountedLocation,
  createUnregisteredLocation,
  isUnmountedLocation,
  isUnregisteredLocation,
  type LocationStore,
} from './location';

export class LocationManagerStore {
  locations = observable.map<string, LocationStore>();
  pendingCreationIds = observable.set<string>();
  private _locationMountPromises = new Map<string, Promise<void>>();
  private _loadPromise: Promise<void> | null = null;

  constructor() {
    makeObservable(this, { locations: observable, pendingCreationIds: observable });
  }

  load(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._doLoad();
    }
    return this._loadPromise;
  }

  private async _doLoad(): Promise<void> {
    // Only surface locations that still have at least one agent — a location
    // with no agents lingers in the DB (kept for reuse) but has no sidebar row.
    const [rawLocations, agents] = await Promise.all([
      rpc.locations.getLocations(),
      rpc.agents.getAgents(),
    ]);
    const locationIdsWithAgents = new Set(agents.map((a) => a.locationId));
    const toMount: string[] = [];
    runInAction(() => {
      for (const loc of rawLocations) {
        if (!locationIdsWithAgents.has(loc.id)) continue;
        if (this.locations.has(loc.id)) continue;
        this.locations.set(loc.id, createUnmountedLocation(loc, 'idle'));
        toMount.push(loc.id);
      }
    });
    await Promise.allSettled(toMount.map((id) => this.mountLocation(id)));
  }

  async createAgent(data: ModeData, id?: string): Promise<string | undefined> {
    const result = await this.startAgentOnboarding(data, { id });
    if (result.kind === 'existing') return result.locationId;

    const completion = await result.completion;
    return completion.success ? result.locationId : undefined;
  }

  async startAgentOnboarding(
    data: ModeData,
    options: StartAgentOnboardingOptions = {}
  ): Promise<StartAgentOnboardingResult> {
    const placeholderId = options.id ?? crypto.randomUUID();
    const dir = data.remote ? data.remote.dir : data.path;
    // Local onboarding can dedup against an existing location for the same dir.
    if (!data.remote && dir !== undefined) {
      const inspection = await rpc.locations.inspectLocationPath({ path: dir });
      if (inspection.existingLocation) {
        return { kind: 'existing', locationId: inspection.existingLocation.id };
      }
    }

    runInAction(() => {
      this.pendingCreationIds.add(placeholderId);
      this.locations.set(
        placeholderId,
        createUnregisteredLocation(placeholderId, data.name, 'registering', 'pick')
      );
    });

    const completion = this._doOnboardAgent(data, placeholderId).finally(() => {
      runInAction(() => this.pendingCreationIds.delete(placeholderId));
    });

    return { kind: 'creating', locationId: placeholderId, completion };
  }

  private async _doOnboardAgent(
    data: ModeData,
    placeholderId: string
  ): Promise<AgentOnboardingCompletion> {
    const dir = data.remote ? data.remote.dir : data.path;
    if (dir === undefined) {
      const error: AgentOnboardingError = {
        type: 'invalid-directory',
        dir: '',
        message: 'A directory is required',
      };
      this._markCreationError(placeholderId, error);
      return err(error);
    }

    let result: AgentOnboardingCompletion;
    try {
      const onboarded = await rpc.agents.onboardAgent({
        name: data.name,
        serverId: data.serverId,
        providerId: data.providerId,
        dir,
        sshHost: data.remote?.sshHost,
        autoApprove: data.autoApprove,
      });
      if (!onboarded.success) {
        result = err(onboarded.error);
      } else {
        const location = (await rpc.locations.getLocations()).find(
          (l) => l.id === onboarded.data.locationId
        );
        if (!location)
          throw new Error(`Onboarded agent's location ${onboarded.data.locationId} not found`);
        // Drop the optimistic placeholder; key the store by the real location id.
        runInAction(() => this.locations.delete(placeholderId));
        this._setAndOpenLocation(location.id, location);
        result = ok();
      }
    } catch (error) {
      this._markUnexpectedCreationError(placeholderId, error);
      throw error;
    }

    if (!result.success) this._markCreationError(placeholderId, result.error);
    return result;
  }

  mountLocation(locationId: string): Promise<void> {
    const inFlight = this._locationMountPromises.get(locationId);
    if (inFlight) return inFlight;

    const location = this.locations.get(locationId);
    if (!location || !isUnmountedLocation(location)) return Promise.resolve();

    runInAction(() => {
      location.phase = 'opening';
      location.error = undefined;
      location.errorCode = undefined;
    });

    const promise = Promise.all([
      rpc.locations.openLocation(locationId),
      viewStateCache.get(`location:${locationId}`),
    ])
      .then(async ([openResult, savedSnapshot]) => {
        if (!openResult.success) {
          runInAction(() => {
            const current = this.locations.get(locationId);
            if (current && isUnmountedLocation(current)) {
              current.phase = 'error';
              if (openResult.error.type === 'path-not-found') {
                current.error = openResult.error.path;
                current.errorCode = 'path-not-found';
              } else if (openResult.error.type === 'error') {
                current.error = openResult.error.message;
                current.errorCode = undefined;
              } else {
                current.error = undefined;
                current.errorCode = undefined;
              }
            }
          });
          return;
        }
        runInAction(() => {
          const current = this.locations.get(locationId);
          if (current && isUnmountedLocation(current)) {
            current.transitionToMounted(
              current.data,
              savedSnapshot as LocationViewSnapshot | undefined
            );
          }
        });
        // Load the session list before provisioning so the sessions map is populated.
        const sessionManager = this.locations.get(locationId)?.mountedLocation?.sessionManager;
        if (sessionManager) {
          await sessionManager.loadSessions();
          const nav = appState.navigation;
          const navParams = nav.viewParamsStore['session'] as
            | { locationId?: string; sessionId?: string }
            | undefined;
          const navSessionId =
            nav.currentViewId === 'session' && navParams?.locationId === locationId
              ? navParams.sessionId
              : undefined;
          if (navSessionId) {
            sessionManager.provisionSession(navSessionId).catch(() => {});
          }
        }
      })
      .catch((error: unknown) => {
        runInAction(() => {
          const current = this.locations.get(locationId);
          if (current && isUnmountedLocation(current)) {
            current.phase = 'error';
            current.error = error instanceof Error ? error.message : String(error);
            current.errorCode = undefined;
          }
        });
        throw error;
      })
      .finally(() => {
        this._locationMountPromises.delete(locationId);
      });

    this._locationMountPromises.set(locationId, promise);
    return promise;
  }

  /**
   * Remove every agent at a location (the sidebar's "Remove Agent" action). The
   * location row is kept in the DB for reuse; it simply drops out of the sidebar
   * once it has no agents.
   */
  async removeLocation(locationId: string): Promise<void> {
    const snapshot = this.locations.get(locationId);
    const agents = await rpc.agents.getAgents(locationId);
    runInAction(() => {
      this.locations.delete(locationId);
    });
    appState.navigation.revalidate();
    try {
      await Promise.all(agents.map((agent) => rpc.agents.deleteAgent(agent.id)));
    } catch (error) {
      runInAction(() => {
        if (snapshot) this.locations.set(locationId, snapshot);
      });
      throw error;
    }
  }

  removeUnregisteredLocation(locationId: string): void {
    runInAction(() => {
      const store = this.locations.get(locationId);
      if (store && isUnregisteredLocation(store)) {
        this.locations.delete(locationId);
      }
    });
  }

  private _setAndOpenLocation(id: string, location: Location): void {
    runInAction(() => {
      const current = this.locations.get(id);
      if (current) {
        current.transitionToUnmounted(location, 'opening');
      } else {
        this.locations.set(id, createUnmountedLocation(location, 'opening'));
      }
    });
    void this.mountLocation(id);
  }

  private _markCreationError(id: string, error: AgentOnboardingError): void {
    runInAction(() => {
      const store = this.locations.get(id);
      if (store && isUnregisteredLocation(store)) {
        store.phase = 'error';
        store.error = creationErrorMessage(error);
      }
    });
  }

  private _markUnexpectedCreationError(id: string, error: unknown): void {
    runInAction(() => {
      const store = this.locations.get(id);
      if (store && isUnregisteredLocation(store)) {
        store.phase = 'error';
        store.error = error instanceof Error ? error.message : String(error);
      }
    });
  }
}

function creationErrorMessage(error: AgentOnboardingError): string {
  switch (error.type) {
    case 'switch-agent-not-on-server':
      return `This agent isn't registered on ${error.serverName}. Pick the server it belongs to.`;
    case 'switch-server-unauthenticated':
      return `Sign in to ${error.serverName} before adding this agent.`;
    case 'invalid-directory':
      return error.message;
    default:
      return error.message;
  }
}

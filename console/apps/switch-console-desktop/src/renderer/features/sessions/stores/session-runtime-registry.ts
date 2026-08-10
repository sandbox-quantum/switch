import { SessionRuntimeStore } from './session-runtime-store';

type SessionRuntimeRegistryEntry = {
  store: SessionRuntimeStore;
  refCount: number;
  activated: boolean;
};

/**
 * Ref-counted renderer-side cache of per-location session runtimes, keyed by
 * location id. Every session at a location shares one runtime.
 */
export class SessionRuntimeRegistryStore {
  private readonly entries = new Map<string, SessionRuntimeRegistryEntry>();

  acquire(locationId: string, path: string): SessionRuntimeStore {
    const existing = this.entries.get(locationId);
    if (existing) {
      existing.refCount += 1;
      return existing.store;
    }

    const store = new SessionRuntimeStore(locationId, path);
    this.entries.set(locationId, { store, refCount: 1, activated: false });
    return store;
  }

  get(locationId: string): SessionRuntimeStore | undefined {
    return this.entries.get(locationId)?.store;
  }

  activate(locationId: string): void {
    const entry = this.entries.get(locationId);
    if (!entry || entry.activated) {
      return;
    }
    entry.activated = true;
    entry.store.activate();
  }

  release(locationId: string): void {
    const entry = this.entries.get(locationId);
    if (!entry) {
      return;
    }

    entry.refCount -= 1;

    if (entry.refCount <= 0) {
      entry.store.dispose();
      this.entries.delete(locationId);
    }
  }
}

export const sessionRuntimeRegistry = new SessionRuntimeRegistryStore();

import type { LocationRuntime } from './location-runtime';

export type TeardownMode = 'detach' | 'terminate';

type LocationRuntimeHooks = {
  onCreate?: (runtime: LocationRuntime) => Promise<void>;
  onCreateSideEffect?: (runtime: LocationRuntime) => void;
  onDestroy?: (runtime: LocationRuntime) => Promise<void>;
  onDetach?: (runtime: LocationRuntime) => Promise<void>;
};

export type LocationRuntimeFactoryResult = { runtime: LocationRuntime } & LocationRuntimeHooks;

type RuntimeEntry = {
  runtime: LocationRuntime;
  refCount: number;
  onDestroy?: (runtime: LocationRuntime) => Promise<void>;
  onDetach?: (runtime: LocationRuntime) => Promise<void>;
};

/**
 * Ref-counted registry of live location runtimes, keyed by location id. Every
 * session at a location shares one runtime; the last release tears it down
 * (running teardown scripts on `terminate`, skipping them on `detach`).
 */
export class LocationRuntimeRegistry {
  private entries = new Map<string, RuntimeEntry>();
  private acquiring = new Map<string, Promise<LocationRuntime>>();

  async acquire(
    locationId: string,
    factory: () => Promise<LocationRuntimeFactoryResult>
  ): Promise<LocationRuntime> {
    const existing = this.entries.get(locationId);
    if (existing) {
      existing.refCount += 1;
      return existing.runtime;
    }

    const inFlight = this.acquiring.get(locationId);
    if (inFlight) {
      const runtime = await inFlight;
      const current = this.entries.get(locationId);
      if (current) current.refCount += 1;
      return runtime;
    }

    const pending = factory()
      .then(async (result) => {
        this.entries.set(locationId, {
          runtime: result.runtime,
          refCount: 1,
          onDestroy: result.onDestroy,
          onDetach: result.onDetach,
        });
        result.onCreateSideEffect?.(result.runtime);
        await result.onCreate?.(result.runtime);
        return result.runtime;
      })
      .finally(() => {
        this.acquiring.delete(locationId);
      });

    this.acquiring.set(locationId, pending);
    return pending;
  }

  async release(locationId: string, mode: TeardownMode = 'terminate'): Promise<void> {
    const entry = this.entries.get(locationId);
    if (!entry) {
      const inFlight = this.acquiring.get(locationId);
      if (inFlight) {
        await inFlight;
        await this.release(locationId, mode);
      }
      return;
    }

    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }

    this.entries.delete(locationId);
    if (mode === 'terminate') {
      await entry.onDestroy?.(entry.runtime);
    }
    await entry.runtime.dispose?.();
    await entry.runtime.lifecycleService.dispose();
    if (mode === 'detach') {
      await entry.onDetach?.(entry.runtime);
    }
  }

  /** Release the runtime regardless of how many sessions still hold it. */
  async releaseAll(locationId: string, mode: TeardownMode = 'terminate'): Promise<void> {
    const entry = this.entries.get(locationId);
    if (!entry) {
      const inFlight = this.acquiring.get(locationId);
      if (inFlight) {
        await inFlight;
        return this.releaseAll(locationId, mode);
      }
      return;
    }
    entry.refCount = 1;
    await this.release(locationId, mode);
  }

  get(locationId: string): LocationRuntime | undefined {
    return this.entries.get(locationId)?.runtime;
  }

  refCount(locationId: string): number {
    return this.entries.get(locationId)?.refCount ?? 0;
  }

  async disposeAll(mode: TeardownMode = 'terminate'): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (mode === 'terminate') {
          await entry.onDestroy?.(entry.runtime);
        }
        await entry.runtime.dispose?.();
        await entry.runtime.lifecycleService.dispose();
        if (mode === 'detach') {
          await entry.onDetach?.(entry.runtime);
        }
      })
    );
  }
}

export const locationRuntimeRegistry = new LocationRuntimeRegistry();

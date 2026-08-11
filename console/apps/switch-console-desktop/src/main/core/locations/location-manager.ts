import { err, ok, type Result } from '@switch-console/shared';
import type { IDisposable } from '@switch-console/shared';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { LifecycleMap } from '@main/lib/lifecycle-map';
import { log } from '@main/lib/logger';
import type { Location } from '@shared/core/locations/locations';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import { createProvider } from './create-location-provider';
import type { LocationProvider } from './location-provider';
import { TimeoutSignal, withTimeout } from './utils';

const OPEN_PROVIDER_TIMEOUT_MS = 20_000;
const TEARDOWN_PROVIDER_TIMEOUT_MS = 60_000;

type LocationManagerHooks = {
  locationOpened: (locationId: string, provider: LocationProvider) => void | Promise<void>;
  locationClosed: (locationId: string) => void | Promise<void>;
};

type ProviderLifecycleError =
  | { type: 'timeout'; message: string; timeout: number }
  | { type: 'error'; message: string };

function toLifecycleError(e: unknown): ProviderLifecycleError {
  if (e instanceof TimeoutSignal) return { type: 'timeout', message: e.message, timeout: e.ms };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

class LocationManager implements Hookable<LocationManagerHooks>, IDisposable {
  private readonly _hooks = new HookCore<LocationManagerHooks>((name, e) =>
    log.error(`LocationManager: ${String(name)} hook error`, e)
  );
  private readonly _lifecycle = new LifecycleMap<
    LocationProvider,
    ProviderLifecycleError,
    ProviderLifecycleError
  >({
    postProvision: (id, provider) => this._hooks.callHookBackground('locationOpened', id, provider),
    postTeardown: (id) => this._hooks.callHookBackground('locationClosed', id),
  });

  on<K extends keyof LocationManagerHooks>(name: K, handler: LocationManagerHooks[K]) {
    return this._hooks.on(name, handler);
  }

  async openLocation(
    location: Location
  ): Promise<Result<LocationProvider, ProviderLifecycleError>> {
    return this._lifecycle.provision(location.id, async () => {
      try {
        const provider = await withTimeout(createProvider(location), OPEN_PROVIDER_TIMEOUT_MS);
        return ok(provider);
      } catch (e) {
        const initError = toLifecycleError(e);
        // A location on a host that is down cannot open, and that is an
        // expected condition the host's reachability state already reports —
        // logging it as an app error made every outage look like a defect.
        const message = 'LocationManager: error during location initialization';
        const metadata = { locationId: location.id, ...initError };
        if (e instanceof HostUnreachableError) log.warn(message, metadata);
        else log.error(message, metadata);
        return err(initError);
      }
    });
  }

  async closeLocation(locationId: string): Promise<Result<void, ProviderLifecycleError>> {
    return (
      this._lifecycle.teardown(locationId, async (provider) => {
        try {
          await withTimeout(provider.dispose(), TEARDOWN_PROVIDER_TIMEOUT_MS);
          return ok();
        } catch (e) {
          const error = toLifecycleError(e);
          log.error('LocationManager: error during location teardown', { locationId, ...error });
          return err(error);
        }
      }) ?? ok()
    );
  }

  getLocation(locationId: string): LocationProvider | undefined {
    return this._lifecycle.get(locationId);
  }

  async dispose(): Promise<void> {
    const ids = Array.from(this._lifecycle.keys());
    await Promise.allSettled(ids.map((id) => this.closeLocation(id)));
    for (const id of ids) {
      const status = this._lifecycle.teardownStatus(id);
      if (status.status === 'error') {
        log.error('LocationManager: location teardown error recorded after dispose', {
          locationId: id,
          message: status.error.message,
        });
      }
    }
  }
}

export const locationManager = new LocationManager();

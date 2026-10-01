import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Switch Cloud's origin as this build knows it, read once, for the places that
 * mark the Cloud's server apart from any other server reached by URL.
 *
 * Read lazily on first use rather than at import, so a view that never asks
 * never makes the call. A build with no Cloud, or one whose configuration
 * could not be read, has no origin here; `useSwitchCloud` is where the
 * difference between those two is shown.
 */
class SwitchCloudStore {
  private originValue: string | null = null;
  private requested = false;

  constructor() {
    makeAutoObservable<SwitchCloudStore, 'requested'>(this, { requested: false });
  }

  get origin(): string | null {
    if (!this.requested) this.load();
    return this.originValue;
  }

  private load(): void {
    this.requested = true;
    void rpc.switchServers.switchCloud().then(
      (endpoint) => {
        runInAction(() => {
          this.originValue = endpoint ? endpoint.url : null;
        });
      },
      () => {}
    );
  }
}

export const switchCloudStore = new SwitchCloudStore();

/** Whether a server is the one this build treats as Switch Cloud. */
export function isSwitchCloudServer(server: SwitchServer): boolean {
  const origin = switchCloudStore.origin;
  if (origin === null) return false;
  try {
    return new URL(server.gatewayUrl).origin === origin;
  } catch {
    return false;
  }
}

import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';

/**
 * Whether this build or run offers Switch Cloud at all, as the main process
 * decides it. Read once at startup, before the first render; off until then.
 * Off hides every Cloud surface: cloud agents and machines, their connections,
 * and the "Switch cloud" run location. Where the Cloud choice is offered is
 * decided by `useSwitchCloud`, which reads no Cloud when this is off.
 */
class SwitchCloudFeature {
  enabled = false;

  constructor() {
    makeAutoObservable(this);
  }

  load(): Promise<void> {
    return rpc.switchServers.switchCloudEnabled().then(
      (enabled) =>
        runInAction(() => {
          this.enabled = enabled;
        }),
      (error: unknown) =>
        log.error('Could not read whether Switch Cloud is turned on; it stays off', { error })
    );
  }
}

export const switchCloudFeature = new SwitchCloudFeature();

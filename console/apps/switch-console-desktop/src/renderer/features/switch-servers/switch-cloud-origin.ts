import { observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { type SwitchServer, urlOrigin } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

/**
 * Switch Cloud's origin, as the main process names it: null until it has been
 * read, and when this build names no Cloud. Read once; the answer belongs to
 * the build or the run, not to anything that changes while the app is open.
 */
const switchCloudOrigin = observable.box<string | null>(null);
let switchCloudRead: Promise<void> | null = null;

/** Read where Switch Cloud is, once; settles when the answer is in. */
export function loadSwitchCloudOrigin(): Promise<void> {
  switchCloudRead ??= Promise.resolve()
    .then(() => rpc.switchServers.switchCloud())
    .then(
      (endpoint) => runInAction(() => switchCloudOrigin.set(endpoint?.url ?? null)),
      (error: unknown) =>
        log.error('Could not read where Switch Cloud is; cloud agents are not offered', { error })
    );
  return switchCloudRead;
}

/**
 * Whether this server is Switch Cloud, the deployment that runs cloud agents.
 * False until the Cloud's address has been read; observers render again once
 * it has.
 */
export function isSwitchCloudServer(server: Pick<SwitchServer, 'url'>): boolean {
  void loadSwitchCloudOrigin();
  const origin = switchCloudOrigin.get();
  return origin !== null && urlOrigin(server.url) === urlOrigin(origin);
}

/** The Switch Cloud server registered here, or null when there is none or no Cloud is named. */
export function managedCloudServerId(): string | null {
  void loadSwitchCloudOrigin();
  if (switchCloudOrigin.get() === null) return null;
  return switchServersStore.servers.find(isSwitchCloudServer)?.id ?? null;
}

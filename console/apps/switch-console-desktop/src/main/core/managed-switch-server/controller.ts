import type {
  DockerAvailability,
  LocalServerStatus,
  StartLocalServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { localServerService } from './local-server-service';

export const localSwitchServerController = createRPCController({
  getStatus: (): Promise<LocalServerStatus> => Promise.resolve(localServerService.getStatus()),

  detectDocker: (): Promise<DockerAvailability> => localServerService.detectDocker(),

  start: (): Promise<StartLocalServerResult> => localServerService.start(),

  stop: (): Promise<void> => localServerService.stop(),

  reset: (): Promise<void> => localServerService.reset(),

  /** Dev-only: build the stack's images from the local Switch checkout on the
   * next start, instead of pulling this build's pinned images. */
  setCheckoutBuild: (enabled: boolean): Promise<void> =>
    localServerService.setCheckoutBuild(enabled),
});

import type {
  DockerAvailability,
  LocalActivityEntry,
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

  /** When the running stack started, or null when it is not running. */
  startedAt: (): Promise<string | null> => localServerService.startedAt(),

  /** The stack's recent history, most recent first. */
  activity: (): Promise<LocalActivityEntry[]> => localServerService.activity(),

  /**
   * Move the service on `port` elsewhere and start again. When that moves the
   * API, the agents pointed at it follow: the start registers the new address
   * and moves them (`followManagedServerAddress`).
   */
  useAnotherPort: (port: number): Promise<StartLocalServerResult> =>
    localServerService.useAnotherPort(port),
});

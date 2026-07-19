import type {
  DockerAvailability,
  LocalServerStatus,
  StartLocalServerResult,
} from '@shared/core/local-switch-server/local-switch-server';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { localServerService } from './local-server-service';

export const localSwitchServerController = createRPCController({
  getStatus: (): Promise<LocalServerStatus> => Promise.resolve(localServerService.getStatus()),

  detectDocker: (): Promise<DockerAvailability> => localServerService.detectDocker(),

  start: (): Promise<StartLocalServerResult> => localServerService.start(),

  stop: (): Promise<void> => localServerService.stop(),

  reset: (): Promise<void> => localServerService.reset(),
});

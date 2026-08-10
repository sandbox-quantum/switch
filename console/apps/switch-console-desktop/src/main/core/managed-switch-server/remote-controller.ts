import type {
  DockerAvailability,
  StartLocalServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { RemoteServerStatus } from '@shared/events/remoteSwitchServerEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { remoteServerService } from './remote-server-service';

export const remoteSwitchServerController = createRPCController({
  getStatuses: (): Promise<RemoteServerStatus[]> =>
    Promise.resolve(remoteServerService.getStatuses()),

  detectDocker: (sshHost: string): Promise<DockerAvailability> =>
    remoteServerService.detectDocker(sshHost),

  start: (params: { sshHost: string; name: string }): Promise<StartLocalServerResult> =>
    remoteServerService.start(params.sshHost, params.name),

  stop: (sshHost: string): Promise<void> => remoteServerService.stop(sshHost),

  reset: (sshHost: string): Promise<void> => remoteServerService.reset(sshHost),
});

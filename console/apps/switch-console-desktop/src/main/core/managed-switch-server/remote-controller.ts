import type {
  ConnectRemoteServerResult,
  DockerAvailability,
  RemoteStackProbe,
  StackRegister,
  StartRemoteServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { RemoteServerStatus } from '@shared/events/remoteSwitchServerEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { remoteServerService } from './remote-server-service';

export const remoteSwitchServerController = createRPCController({
  getStatuses: (): Promise<RemoteServerStatus[]> =>
    Promise.resolve(remoteServerService.getStatuses()),

  detectDocker: (sshHost: string): Promise<DockerAvailability> =>
    remoteServerService.detectDocker(sshHost),

  probe: (sshHost: string): Promise<RemoteStackProbe> => remoteServerService.probe(sshHost),

  register: (sshHost: string): Promise<StackRegister> => remoteServerService.register(sshHost),

  start: (params: { sshHost: string; name: string }): Promise<StartRemoteServerResult> =>
    remoteServerService.start(params.sshHost, params.name),

  /** Look at a stack shown as stopped again, as its page opens. */
  refresh: (sshHost: string): Promise<void> => {
    remoteServerService.refresh(sshHost);
    return Promise.resolve();
  },

  /** Stop waiting for another Console's hold on the host's stack. */
  cancelWait: (sshHost: string): Promise<void> => {
    remoteServerService.cancelWait(sshHost);
    return Promise.resolve();
  },

  connect: (params: { sshHost: string; name: string }): Promise<ConnectRemoteServerResult> =>
    remoteServerService.connect(params.sshHost, params.name),

  disconnect: (sshHost: string): Promise<void> => remoteServerService.disconnect(sshHost),

  stop: (sshHost: string): Promise<void> => remoteServerService.stop(sshHost),

  reset: (sshHost: string): Promise<void> => remoteServerService.reset(sshHost),
});

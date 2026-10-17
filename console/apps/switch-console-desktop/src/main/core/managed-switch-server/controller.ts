import { propagateServerApiUrl } from "@main/core/agents/propagate-server-api-url";
import { embeddedControllerService } from "@main/core/embedded-controller/embedded-controllers";
import { getManagedServer } from "@main/core/switch-servers/servers-store";
import type {
  DockerAvailability,
  LocalActivityEntry,
  LocalServerStatus,
  StartLocalServerResult,
} from "@shared/core/managed-switch-server/managed-switch-server";
import { createRPCController } from "@shared/lib/ipc/rpc";
import { localServerService } from "./local-server-service";

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

  /** Turn Mattermost on or off for a server that runs without Docker; applies
   * at the next start. */
  setMattermost: (enabled: boolean): Promise<void> => localServerService.setMattermost(enabled),

  /** When the running stack started, or null when it is not running. */
  startedAt: (): Promise<string | null> => localServerService.startedAt(),

  /** The stack's recent history, most recent first. */
  activity: (): Promise<LocalActivityEntry[]> => localServerService.activity(),

  /**
   * Move the service on `port` elsewhere and start again. When that moves the
   * API, the agents pointed at it follow, as they do when a server's address
   * is edited.
   */
  useAnotherPort: async (port: number): Promise<StartLocalServerResult> => {
    const before = await getManagedServer();
    const result = await localServerService.useAnotherPort(port);
    if (result.kind !== "started" || !before) return result;
    const after = await getManagedServer();
    if (after && after.apiUrl !== before.apiUrl) {
      await propagateServerApiUrl(after.id, after.apiUrl);
      await embeddedControllerService.followServerApiUrl(after.id);
    }
    return result;
  },
});

import { homedir } from 'node:os';
import { machineProvider } from '@main/core/managed-agents/owned-machines';
import { getServer } from '@main/core/switch-servers/servers-store';
import type {
  DeviceAgentGrant,
  DeviceConsentChoice,
  DeviceConsentEvent,
  EmbeddedControllerOverview,
  MachineDetailsChange,
} from '@shared/core/embedded-controller/embedded-controller';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { defaultWorkspacePath, serverWorkspacesDir } from './controller-files';
import { embeddedControllerService, providerPrecheck } from './embedded-controllers';

/** "Run managed agents on this computer", per Switch server. */
export const embeddedControllerController = createRPCController({
  /** `workspaceId`: where to ask the server while this computer is not enrolled. */
  getOverview: (params: {
    serverId: string;
    workspaceId: string | null;
  }): Promise<EmbeddedControllerOverview> =>
    embeddedControllerService.overview(params.serverId, params.workspaceId),

  enable: (params: { serverId: string; workspaceId: string }): Promise<void> =>
    embeddedControllerService.enable(params.serverId, params.workspaceId),

  disable: (serverId: string): Promise<void> => embeddedControllerService.disable(serverId),

  restart: (serverId: string): Promise<void> => embeddedControllerService.restart(serverId),

  /** Checks every provider on this computer again now, and reports it to the server. */
  recheckProviders: (serverId: string): Promise<void> =>
    embeddedControllerService.recheckProviders(serverId),

  /**
   * Checks this computer's providers now, ahead of any controller, for the
   * one started later to take; as onboarding opens. Returns at once.
   */
  precheckProviders: (): void => providerPrecheck.start(),

  /**
   * What that check has found so far, as a machine's providers read; null
   * when it was not started in this session.
   */
  precheckedProviders: async (): Promise<MachineProvider[] | null> =>
    (await providerPrecheck.results())?.map(machineProvider) ?? null,

  /** Renames this computer as a machine and/or changes its description, on the server. */
  updateDetails: (params: { serverId: string; changes: MachineDetailsChange }): Promise<void> =>
    embeddedControllerService.updateDetails(params.serverId, params.changes),

  dismissRemoved: (serverId: string): Promise<void> => embeddedControllerService.dismiss(serverId),

  /** What every server's agents ask of this computer that the person has not answered. */
  consentAsks: (): Promise<DeviceConsentEvent[]> => embeddedControllerService.consentAsks(),

  /** What this computer allows each agent of a server, whatever its definition says. */
  deviceGrants: (serverId: string): Promise<DeviceAgentGrant[]> =>
    embeddedControllerService.deviceGrants(serverId),

  /** Allows an agent what it asked of this computer; only the person here can. */
  allowForAgent: (params: {
    serverId: string;
    agentId: string;
    choice: DeviceConsentChoice;
  }): Promise<void> =>
    embeddedControllerService.allowForAgent(params.serverId, params.agentId, params.choice),

  /** Says no to what an agent asked of this computer, so it is not asked again. */
  denyForAgent: (params: {
    serverId: string;
    agentId: string;
    choice: DeviceConsentChoice;
  }): Promise<void> =>
    embeddedControllerService.denyForAgent(params.serverId, params.agentId, params.choice),

  /** Takes back what this computer allowed an agent; `'all'` takes back everything. */
  revokeForAgent: (params: {
    serverId: string;
    agentId: string;
    choice: DeviceConsentChoice | 'all';
  }): Promise<void> =>
    embeddedControllerService.revokeForAgent(params.serverId, params.agentId, params.choice),

  /** Enrolls this computer again when the server no longer knows the machine it was. */
  enrollAgain: (serverId: string): Promise<void> => embeddedControllerService.enrollAgain(serverId),

  /**
   * Where this computer's controller puts a managed agent that names no
   * directory, `~` for the home directory; null for a name that cannot be a
   * directory, which the form refuses anyway.
   */
  defaultWorkspace: async (params: { serverId: string; name: string }): Promise<string | null> => {
    const server = await getServer(params.serverId);
    if (!server) throw new Error(`No server ${params.serverId} in Console.`);
    const path = defaultWorkspacePath(serverWorkspacesDir(homedir(), server.url), params.name);
    if (path === null) return null;
    const home = homedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  },
});

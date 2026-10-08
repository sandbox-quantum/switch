import type {
  ControllerProviderReport,
  ManagementController,
} from '@main/core/switch-servers/gateway-client';
import type { MachineProvider, OwnedMachine } from '@shared/core/managed-agents/managed-agents';

/** This Console's own controllers on a server: this computer's, and its SSH hosts'. */
export type LocalControllers = {
  thisComputer: string | null;
  sshHosts: { controllerId: string; sshHost: string }[];
};

/** A provider report as the New agent form offers it: ready, or why not. */
export function machineProvider(report: ControllerProviderReport): MachineProvider {
  const problem = !report.installed
    ? 'not installed'
    : report.auth === 'ok'
      ? null
      : report.auth === 'missing'
        ? 'not logged in'
        : report.auth === 'expired'
          ? 'login expired'
          : 'login not checked yet';
  return { provider: report.provider, ready: problem === null, problem };
}

/** The owner's machines an agent can be placed on: every controller but the revoked ones. */
export function ownedMachines(
  controllers: ManagementController[],
  local: LocalControllers
): OwnedMachine[] {
  return controllers
    .filter((controller) => controller.state !== 'revoked')
    .map((controller): OwnedMachine => {
      const sshHost = local.sshHosts.find((host) => host.controllerId === controller.id)?.sshHost;
      return {
        id: controller.id,
        name: controller.name,
        kind: controller.kind,
        state: controller.state,
        providers: controller.providers.map(machineProvider),
        acceptsLogins: controller.sealingKey !== null,
        workspacesDir: controller.workspacesDir,
        local:
          controller.id === local.thisComputer
            ? { kind: 'this-computer' }
            : sshHost
              ? { kind: 'ssh-host', sshHost }
              : null,
      };
    });
}

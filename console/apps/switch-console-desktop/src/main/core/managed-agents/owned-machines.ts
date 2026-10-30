import type { ControllerProviderReport } from '@main/core/switch-servers/controller-provider-report';
import type { ManagementController } from '@main/core/switch-servers/gateway-client';
import {
  isCloudMachine,
  type MachineProvider,
  type OwnedMachine,
  type ThisComputerReport,
} from '@shared/core/managed-agents/managed-agents';

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
          : report.problem
            ? 'login could not be checked'
            : 'login not checked yet';
  return {
    provider: report.provider,
    ready: problem === null,
    problem,
    detail: problem === null ? null : report.problem,
    loginHelps: report.loginHelps,
  };
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
        cloud: isCloudMachine(controller),
        workspacesDir: controller.workspacesDir,
        os: controller.os,
        local:
          controller.id === local.thisComputer
            ? { kind: 'this-computer' }
            : sshHost
              ? { kind: 'ssh-host', sshHost }
              : null,
      };
    });
}

/**
 * `serverIds` with `preferred` moved to the front when it is among them: the
 * server Console is on now, whose report is the one its screens are about,
 * since controllers on different servers can each say something different.
 */
export function preferredFirst(serverIds: readonly string[], preferred: string | null): string[] {
  return preferred && serverIds.includes(preferred)
    ? [preferred, ...serverIds.filter((serverId) => serverId !== preferred)]
    : [...serverIds];
}

/**
 * What this computer's controller last reported to the first of `serverIds`
 * that has a report from it, online: Console's own check of the providers
 * is only the fallback, since this report is what Switch decides by. Null
 * when no server has one, or none could be reached; a server that cannot
 * be asked is skipped, not a failure.
 */
export async function thisComputerReport(
  serverIds: readonly string[],
  machinesOn: (serverId: string) => Promise<OwnedMachine[] | null>
): Promise<ThisComputerReport | null> {
  for (const serverId of serverIds) {
    let machines: OwnedMachine[] | null;
    try {
      machines = await machinesOn(serverId);
    } catch {
      continue;
    }
    const machine = machines?.find(
      (candidate) =>
        candidate.local?.kind === 'this-computer' &&
        candidate.state === 'online' &&
        candidate.providers.length > 0
    );
    if (machine) return { serverId, providers: machine.providers };
  }
  return null;
}

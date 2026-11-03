import { machineLabel } from '@renderer/features/locations/components/add-agent-modal/server-run-locations';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';

/** A device a managed agent could move to, or why it cannot. */
export type MoveTarget = {
  machineId: string;
  label: string;
  /** Why it cannot be picked, in a few words; null when it can. */
  blocked: string | null;
};

/**
 * The owner's other devices as places to move an agent to, this computer
 * first. Switch refuses a move to a device that is offline or whose provider
 * is not ready, so those are listed but blocked with the reason; a device that
 * has not reported its providers yet is left to Switch to judge.
 */
export function moveTargets(
  agent: ManagedAgentView,
  machines: readonly OwnedMachine[]
): MoveTarget[] {
  const provider = agent.definition.provider;
  const providerName = providerDisplayName(provider) ?? provider;
  return machines
    .filter((machine) => machine.id !== agent.machine?.id && machine.state !== 'revoked')
    .sort(
      (a, b) =>
        Number(b.local?.kind === 'this-computer') - Number(a.local?.kind === 'this-computer') ||
        machineLabel(a).localeCompare(machineLabel(b))
    )
    .map((machine): MoveTarget => {
      const report = machine.providers.find((entry) => entry.provider === provider);
      const blocked =
        machine.state !== 'online'
          ? 'offline'
          : machine.providers.length === 0
            ? null
            : !report
              ? `${providerName} not installed`
              : report.ready
                ? null
                : `${providerName} ${report.problem ?? 'not ready'}`;
      return {
        machineId: machine.id,
        label: machine.cloud ? 'Switch cloud' : machineLabel(machine),
        blocked,
      };
    });
}

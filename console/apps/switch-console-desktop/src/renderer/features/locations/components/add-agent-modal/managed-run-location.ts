import { failureText } from '@renderer/lib/errors/describe-failure';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';

/** What the create form says under the run location about where a new agent runs. */
export type MachineNotice =
  | { kind: 'console'; text: string }
  | { kind: 'managed'; text: string }
  | { kind: 'blocked'; text: string; enable: { label: string } | null };

/** `location` is the run location as the form names it: "This computer", or the host's name. */
export function newAgentMachineNotice(
  machine: NewAgentMachine,
  location: { label: string; sshHost: string | null }
): MachineNotice {
  if (!machine.management)
    return {
      kind: 'console',
      text: 'This server does not have agent management turned on, so this Console runs the agent.',
    };
  if (machine.blocker)
    return {
      kind: 'blocked',
      text: machine.blocker,
      enable: machine.canEnable
        ? {
            label: location.sshHost
              ? `Make ${location.label} a machine`
              : 'Run managed agents on this computer',
          }
        : null,
    };
  const name = machine.target?.machineName;
  const where =
    name && name !== location.label ? `${location.label} (machine “${name}”)` : location.label;
  return {
    kind: 'managed',
    text: `Runs as a managed agent on ${where}: Switch places it on the machine’s agents controller, which runs it. You can bring it back to this Console later from its settings.`,
  };
}

/** Why the create button is greyed out on the machine's account, or null when the machine is not why. */
export function machineDisabledReason(input: {
  checking: boolean;
  error: unknown;
  machine: NewAgentMachine | undefined;
}): string | null {
  if (input.checking) return 'Checking whether this server runs managed agents…';
  if (input.error)
    return failureText(
      input.error,
      'Console could not ask the server whether it runs managed agents.'
    );
  if (input.machine?.management && input.machine.blocker) return input.machine.blocker;
  return null;
}

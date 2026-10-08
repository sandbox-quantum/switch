import type { MigrationMachine } from '@shared/core/agent-migration/agent-migration';

export type MigrationTone = 'ok' | 'busy' | 'warn' | 'error' | 'neutral';

/** How one machine's row reads: a badge, and the one line under it that says what is wrong. */
export function migrationMachineState(machine: MigrationMachine): {
  tone: MigrationTone;
  label: string;
  note: string | null;
} {
  const controller = machine.controller;
  if (controller?.kind === 'incompatible')
    return { tone: 'neutral', label: 'Server too old', note: controller.reason };
  if (controller?.kind === 'failed')
    return { tone: 'error', label: 'Needs attention', note: controller.reason };
  if (machine.moved === machine.total) return { tone: 'ok', label: 'Done', note: null };
  if (machine.problems.length > 0)
    return {
      tone: 'warn',
      label: `${machine.problems.length} stuck`,
      note: machine.problems.length === 1 ? machine.problems[0]!.message : null,
    };
  if (controller === null) return { tone: 'neutral', label: 'Not checked yet', note: null };
  return { tone: 'busy', label: 'Moving', note: null };
}

/** Machines needing attention first, then by machine (this computer first) and server. */
export function sortMachines(machines: MigrationMachine[]): MigrationMachine[] {
  const rank = (machine: MigrationMachine) => {
    const tone = migrationMachineState(machine).tone;
    return tone === 'error' ? 0 : tone === 'warn' ? 1 : 2;
  };
  return [...machines].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.sshHost ?? '').localeCompare(b.sshHost ?? '') ||
      a.serverId.localeCompare(b.serverId)
  );
}

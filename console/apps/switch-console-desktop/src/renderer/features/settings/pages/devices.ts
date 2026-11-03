import { type OwnedMachine } from '@shared/core/managed-agents/managed-agents';

export type DeviceType = 'computer' | 'cloud' | 'ssh';

export type DeviceRow = {
  id: string;
  name: string;
  /** What tells it apart under its name: this computer, or the SSH host it is. */
  detail: string | null;
  state: OwnedMachine['state'];
  type: DeviceType;
  agents: number;
  platform: string | null;
};

const PLATFORM_NAMES: Record<string, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};

/**
 * Your machines as the Your devices table lists them: this computer first,
 * then the rest by name, each with how many of your agents run on it.
 * A revoked machine can run nothing and is left out.
 */
export function deviceRows(
  machines: readonly OwnedMachine[],
  agents: readonly { machine: { id: string } | null }[]
): DeviceRow[] {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    if (agent.machine) counts.set(agent.machine.id, (counts.get(agent.machine.id) ?? 0) + 1);
  }
  return machines
    .filter((machine) => machine.state !== 'revoked')
    .map((machine): DeviceRow => {
      const local = machine.local;
      return {
        id: machine.id,
        name: machine.cloud ? 'Switch cloud' : machine.name,
        detail:
          local?.kind === 'this-computer'
            ? 'This computer'
            : local?.kind === 'ssh-host'
              ? local.sshHost
              : null,
        state: machine.state,
        type: machine.cloud ? 'cloud' : local?.kind === 'ssh-host' ? 'ssh' : 'computer',
        agents: counts.get(machine.id) ?? 0,
        platform: machine.os ? (PLATFORM_NAMES[machine.os] ?? machine.os) : null,
      };
    })
    .sort((a, b) => {
      const here = Number(b.detail === 'This computer') - Number(a.detail === 'This computer');
      return here !== 0 ? here : a.name.localeCompare(b.name);
    });
}

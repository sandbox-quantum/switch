import { describe, expect, it } from 'vitest';
import type { MigrationMachine } from '@shared/core/agent-migration/agent-migration';
import { migrationMachineState, sortMachines } from './migration-presentation';

const machine = (overrides: Partial<MigrationMachine>): MigrationMachine => ({
  machine: 'this computer',
  sshHost: null,
  serverId: 'server-1',
  total: 3,
  moved: 3,
  controller: { kind: 'ready' },
  checkedAt: '2026-10-07T17:00:00Z',
  problems: [],
  ...overrides,
});

const problem = (name: string, message: string) => ({
  agentId: name,
  name,
  machine: 'dev-vm',
  message,
});

describe('migrationMachineState', () => {
  it('is done once every agent moved', () => {
    expect(migrationMachineState(machine({}))).toEqual({ tone: 'ok', label: 'Done', note: null });
  });

  it('says why a machine needs attention, once', () => {
    expect(
      migrationMachineState(
        machine({ moved: 0, controller: { kind: 'failed', reason: 'ssh: timed out' } })
      )
    ).toEqual({ tone: 'error', label: 'Needs attention', note: 'ssh: timed out' });
  });

  it('tells a server too old for the controller apart from a failure', () => {
    expect(
      migrationMachineState(
        machine({ moved: 0, controller: { kind: 'incompatible', reason: 'Upgrade it.' } })
      )
    ).toMatchObject({ tone: 'neutral', label: 'Server too old', note: 'Upgrade it.' });
  });

  it('counts stuck agents, naming the reason when there is one', () => {
    expect(
      migrationMachineState(machine({ moved: 2, problems: [problem('builder', 'refused')] }))
    ).toEqual({ tone: 'warn', label: '1 stuck', note: 'refused' });
    expect(
      migrationMachineState(machine({ moved: 1, problems: [problem('a', 'x'), problem('b', 'y')] }))
    ).toEqual({ tone: 'warn', label: '2 stuck', note: null });
  });

  it('is moving while agents remain and nothing is wrong', () => {
    expect(migrationMachineState(machine({ moved: 1 }))).toMatchObject({ tone: 'busy' });
    expect(migrationMachineState(machine({ moved: 1, controller: null }))).toMatchObject({
      label: 'Not checked yet',
    });
  });
});

describe('sortMachines', () => {
  it('puts machines needing attention first, then this computer, then hosts by name', () => {
    const sorted = sortMachines([
      machine({ sshHost: 'b-host', machine: 'b-host' }),
      machine({ sshHost: 'a-host', machine: 'a-host' }),
      machine({
        sshHost: 'z-host',
        machine: 'z-host',
        moved: 0,
        controller: { kind: 'failed', reason: 'x' },
      }),
      machine({}),
    ]);
    expect(sorted.map((m) => m.machine)).toEqual(['z-host', 'this computer', 'a-host', 'b-host']);
  });
});

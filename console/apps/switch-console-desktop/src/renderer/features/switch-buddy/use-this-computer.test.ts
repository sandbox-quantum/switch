import { describe, expect, it, vi } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));

const { thisComputerIn, thisComputerState } = await import('./use-this-computer');

function machine(kind: string | null, providers: number): OwnedMachine {
  return {
    id: `m-${kind}`,
    local: kind === null ? null : { kind },
    providers: Array.from({ length: providers }, (_, i) => ({ provider: `p${i}`, ready: true })),
  } as unknown as OwnedMachine;
}

describe('thisComputerState', () => {
  it('has failed, with why, when setting this computer up failed', () => {
    expect(thisComputerState('No Docker.', [machine('this-computer', 2)])).toEqual({
      kind: 'failed',
      error: 'No Docker.',
    });
  });

  it('has failed when the server runs no managed agents', () => {
    expect(thisComputerState(null, null)).toMatchObject({ kind: 'failed' });
  });

  it('is starting until this computer is a machine of the workspace and has reported', () => {
    expect(thisComputerState(null, undefined)).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, [])).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, [machine('remote', 3)])).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, [machine('this-computer', 0)])).toEqual({ kind: 'starting' });
  });

  it('is ready once this computer has reported its providers', () => {
    const mine = machine('this-computer', 2);
    expect(thisComputerState(null, [machine(null, 1), mine])).toEqual({
      kind: 'ready',
      machine: mine,
    });
  });
});

describe('thisComputerIn', () => {
  it('finds this computer among the machines, or nothing', () => {
    const mine = machine('this-computer', 0);
    expect(thisComputerIn([machine('remote', 1), mine])).toBe(mine);
    expect(thisComputerIn([machine('remote', 1)])).toBeNull();
    expect(thisComputerIn(undefined)).toBeNull();
  });
});

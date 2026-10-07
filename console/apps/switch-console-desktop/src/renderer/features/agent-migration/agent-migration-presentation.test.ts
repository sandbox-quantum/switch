import { describe, expect, it } from 'vitest';
import type { AgentMigrationState } from '@shared/core/agent-migration/agent-migration';
import {
  migrationAction,
  migrationSummary,
  moveAllMachineState,
  moveAllOutcome,
  moveAllState,
  moveAllSummary,
  operationLabel,
  targetName,
} from './agent-migration-presentation';

const CONSOLE: AgentMigrationState = {
  agentId: 'agent-1',
  runner: 'console',
  operation: null,
  target: { kind: 'this-computer', serverId: 'server-1', machineName: 'build-box' },
  blocker: null,
  canEnableTarget: false,
  notCarried: [],
  managed: null,
};

const MANAGED: AgentMigrationState = {
  ...CONSOLE,
  runner: 'managed',
  managed: {
    controllerId: 'controller-1',
    movedAt: '2026-10-01T00:00:00Z',
    machine: { kind: 'running' },
    desiredState: 'running',
    actual: { process: 'running', attached: true, reason: null, detail: null },
    unreadable: null,
  },
};

describe('where an agent runs', () => {
  it('names the machine', () => {
    expect(targetName(CONSOLE.target)).toBe('this computer (build-box)');
    expect(
      targetName({ kind: 'ssh-host', sshHost: 'gpu-1', serverId: 'server-1', machineName: null })
    ).toBe('gpu-1');
    expect(targetName(null)).toBe('a managed machine');
  });

  it('reads as run by this Console before a move', () => {
    expect(migrationSummary(CONSOLE)).toEqual({
      label: 'Run by this Console',
      tone: 'neutral',
      detail: null,
    });
  });

  it('says what its controller reports once moved', () => {
    expect(migrationSummary(MANAGED)).toMatchObject({ label: 'Managed', tone: 'ok' });
    expect(
      migrationSummary({
        ...MANAGED,
        managed: {
          ...MANAGED.managed!,
          actual: {
            process: 'failed',
            attached: false,
            reason: 'provider_login_missing',
            detail: 'Sign in to Claude Code.',
          },
        },
      })
    ).toEqual({
      label: 'Managed, failed',
      tone: 'error',
      detail:
        'this computer (build-box): failed (provider login missing) — Sign in to Claude Code.',
    });
    expect(
      migrationSummary({ ...MANAGED, managed: { ...MANAGED.managed!, actual: null } }).tone
    ).toBe('busy');
    expect(
      migrationSummary({
        ...MANAGED,
        managed: { ...MANAGED.managed!, unreadable: 'Switch no longer manages this agent.' },
      })
    ).toMatchObject({ tone: 'warn', detail: 'Switch no longer manages this agent.' });
  });

  it('reads as not running while its machine’s controller is stopped, whatever it last reported', () => {
    const reason = 'gpu-1’s controller is not running. Start it again from the host’s page.';
    expect(
      migrationSummary({
        ...MANAGED,
        managed: { ...MANAGED.managed!, machine: { kind: 'stopped', reason } },
      })
    ).toEqual({ label: 'Managed, not running', tone: 'warn', detail: reason });
    expect(
      migrationSummary({
        ...MANAGED,
        managed: {
          ...MANAGED.managed!,
          machine: {
            kind: 'unknown',
            reason: 'Console cannot tell whether gpu-1’s controller runs.',
          },
        },
      })
    ).toEqual({
      label: 'Managed',
      tone: 'warn',
      detail: 'Console cannot tell whether gpu-1’s controller runs.',
    });
  });

  it('says its machine was removed, and that Stop managing brings it back, once the controller is gone', () => {
    const stranded: AgentMigrationState = {
      ...MANAGED,
      target: { kind: 'this-computer', serverId: 'server-1', machineName: null },
      managed: { ...MANAGED.managed!, machine: { kind: 'removed' } },
    };
    expect(migrationSummary(stranded)).toEqual({
      label: 'Machine removed',
      tone: 'error',
      detail:
        'The machine it was moved onto, this computer, was removed from Switch, so nothing runs this agent now. Stop managing brings it back to this Console.',
    });
    expect(migrationAction(stranded)).toEqual({
      kind: 'return',
      label: 'Stop managing',
      disabledReason: null,
    });
  });

  it('shows a move in flight', () => {
    const telling: AgentMigrationState = {
      ...CONSOLE,
      operation: { kind: 'moving', stage: 'telling-rooms' },
    };
    expect(migrationSummary(telling)).toEqual({
      label: 'Moving…',
      tone: 'busy',
      detail: 'Telling the rooms it was working in that it is moving…',
    });
    expect(operationLabel({ kind: 'returning', stage: 'waiting-for-controller' })).toBe(
      'Waiting for the machine to stop it…'
    );
  });
});

describe('the action offered', () => {
  it('is Move to managed, disabled with the reason it cannot run', () => {
    expect(migrationAction(CONSOLE)).toEqual({
      kind: 'move',
      label: 'Move to managed',
      disabledReason: null,
    });
    expect(migrationAction({ ...CONSOLE, blocker: 'Turn it on first.' })?.disabledReason).toBe(
      'Turn it on first.'
    );
  });

  it('is Stop managing once moved', () => {
    expect(migrationAction(MANAGED).label).toBe('Stop managing');
  });

  it('is held while a move is in flight', () => {
    expect(
      migrationAction({
        ...CONSOLE,
        operation: { kind: 'moving', stage: 'adopting' },
      })?.disabledReason
    ).toBe('Working…');
  });
});

describe('a Move all', () => {
  it('says what moved, what was skipped and what failed', () => {
    expect(
      moveAllSummary(
        {
          moved: [{ agentId: 'a', name: 'builder' }],
          skipped: [{ agentId: 'b', name: 'reviewer', reason: 'Only its owner can move it.' }],
          failed: [{ agentId: 'c', name: 'tester', message: 'controller offline' }],
        },
        'Moved'
      )
    ).toEqual([
      'Moved builder.',
      'reviewer did not move: Only its owner can move it.',
      'tester failed: controller offline',
    ]);
    expect(moveAllSummary({ moved: [], skipped: [], failed: [] }, 'Brought back')).toEqual([
      'Brought back no agents.',
    ]);
  });
});

const MACHINE = {
  kind: 'ssh-host' as const,
  name: 'dev-vm',
  total: 18,
  managed: 0,
  moving: 0,
  blocked: 0,
  reason: null,
  setUpOnMove: false,
};

describe('whether moving every agent is complete', () => {
  it('adds the machines up, and is complete once every agent is managed', () => {
    expect(
      moveAllState({
        machines: [
          { ...MACHINE, managed: 18 },
          { ...MACHINE, name: 'This computer', kind: 'this-computer', total: 6, managed: 6 },
        ],
      })
    ).toEqual({ tone: 'ok', label: 'Complete', managed: 24, total: 24 });
  });

  it('is moving while any machine moves, and not complete otherwise', () => {
    expect(moveAllState({ machines: [{ ...MACHINE, moving: 1 }] }).label).toBe('Moving…');
    expect(moveAllState({ machines: [{ ...MACHINE, managed: 3 }] })).toMatchObject({
      label: 'Not complete',
      managed: 3,
      total: 18,
    });
    expect(moveAllState({ machines: [] }).label).toBe('Nothing to move');
  });
});

describe('one machine in Move all', () => {
  it('says a host that is not a machine yet is set up by Move all, not that its agents cannot move', () => {
    expect(moveAllMachineState({ ...MACHINE, setUpOnMove: true })).toEqual({
      tone: 'neutral',
      label: 'Not a machine yet',
      note: 'Move all sets dev-vm up as a machine, then moves its agents.',
    });
  });

  it('gives one reason for a blocked machine, and none once it is done', () => {
    expect(
      moveAllMachineState({ ...MACHINE, blocked: 18, reason: 'The server is unreachable.' })
    ).toEqual({ tone: 'warn', label: 'Blocked', note: 'The server is unreachable.' });
    expect(moveAllMachineState({ ...MACHINE, managed: 10, blocked: 2, reason: 'x' }).label).toBe(
      '2 blocked'
    );
    expect(moveAllMachineState({ ...MACHINE, managed: 18 })).toEqual({
      tone: 'ok',
      label: 'Done',
      note: null,
    });
  });
});

describe('what Move all did', () => {
  it('counts the moves and names the first few failures', () => {
    const failed = Array.from({ length: 5 }, (_, index) => ({
      agentId: `a${index}`,
      name: `agent-${index}`,
      message: 'controller offline',
    }));
    expect(
      moveAllOutcome({ moved: [{ agentId: 'm', name: 'mover' }], skipped: [], failed }, 'Moved')
    ).toEqual([
      'Moved 1 agent.',
      'agent-0: controller offline',
      'agent-1: controller offline',
      'agent-2: controller offline',
      "2 more failed; see the agents' pages.",
    ]);
  });
});

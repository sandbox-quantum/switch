import { describe, expect, it } from 'vitest';
import type { AgentMigrationState } from '@shared/core/agent-migration/agent-migration';
import {
  migrationAction,
  migrationSummary,
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
  movesWithParent: null,
  subagents: [],
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

  it('shows a move in flight, including the wait for a turn', () => {
    const waiting: AgentMigrationState = {
      ...CONSOLE,
      operation: { kind: 'moving', stage: 'waiting-for-turn', busySessions: ['s-1', 's-2'] },
    };
    expect(migrationSummary(waiting)).toEqual({
      label: 'Moving…',
      tone: 'busy',
      detail: 'Waiting for the current turn to end (2 sessions working)…',
    });
    expect(
      operationLabel({ kind: 'returning', stage: 'waiting-for-controller', busySessions: [] })
    ).toBe('Waiting for the machine to stop it…');
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

  it('is Stop managing once moved, and nothing for a subagent that moves with its parent', () => {
    expect(migrationAction(MANAGED)?.label).toBe('Stop managing');
    expect(migrationAction({ ...MANAGED, movesWithParent: 'builder' })).toBeNull();
  });

  it('is held while a move is in flight', () => {
    expect(
      migrationAction({
        ...CONSOLE,
        operation: { kind: 'moving', stage: 'adopting', busySessions: [] },
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

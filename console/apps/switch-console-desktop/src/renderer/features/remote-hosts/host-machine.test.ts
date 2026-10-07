import { describe, expect, it } from 'vitest';
import type { PlacedManagedAgent } from '@shared/core/embedded-controller/embedded-controller';
import type { HostControllerOverview } from '@shared/core/host-controllers/host-controllers';
import {
  canRestartHost,
  failureAlreadyShown,
  hostAgentActual,
  hostMachineStatus,
  hostStateKey,
  hostToggleBlocker,
  hostUnknownToServer,
  supervisionNote,
} from './host-machine';

const OFF: HostControllerOverview = {
  sshHost: 'build-box',
  serverId: 'server-1',
  enrollment: null,
  phase: { kind: 'off' },
  process: null,
  remote: { kind: 'ok', controller: null, agents: [] },
  movedAgents: [],
};

const ON: HostControllerOverview = {
  ...OFF,
  enrollment: {
    controllerId: 'controller-1',
    name: 'build-box.internal',
    workspaceId: 'workspace-1',
    supervision: 'systemd',
    enrolledAt: '2026-10-01T00:00:00Z',
  },
  process: { kind: 'running' },
  remote: { kind: 'ok', controller: { state: 'online', lastSeenAt: null }, agents: [] },
};

describe('the state of a host as a machine', () => {
  it('is off until it is set up, saying why a set-up failed', () => {
    expect(hostMachineStatus(OFF)).toEqual({ label: 'Off', tone: 'neutral', detail: null });
    expect(
      hostMachineStatus({ ...OFF, phase: { kind: 'error', message: 'Node 20 is too old.' } })
    ).toEqual({ label: 'Off', tone: 'error', detail: 'Node 20 is too old.' });
    expect(
      hostMachineStatus({ ...OFF, phase: { kind: 'installing', step: 'Enrolling the host…' } })
    ).toEqual({ label: 'Setting up…', tone: 'busy', detail: 'Enrolling the host…' });
  });

  it('says Switch no longer knows the host when it is enrolled but not listed, whatever its process does', () => {
    const unknown = { ...ON, remote: { kind: 'ok' as const, controller: null, agents: [] } };
    expect(hostUnknownToServer(unknown)).toBe(true);
    expect(hostMachineStatus(unknown)).toMatchObject({
      label: 'Unknown to Switch',
      tone: 'error',
      detail: expect.stringContaining('Switch no longer knows build-box as a machine'),
    });
    const stopped = {
      ...unknown,
      process: { kind: 'stopped' as const, state: 'exited', code: 1, log: null },
    };
    expect(hostMachineStatus(stopped).label).toBe('Unknown to Switch');
    expect(hostMachineStatus({ ...unknown, movedAgents: ['jack'] }).detail).toContain('jack');
    expect(hostUnknownToServer(OFF)).toBe(false);
    expect(hostUnknownToServer(ON)).toBe(false);
  });

  it('is running when the host runs it and Switch sees it', () => {
    expect(hostMachineStatus(ON)).toEqual({ label: 'Running', tone: 'ok', detail: null });
  });

  it('says why it is not running, with the last thing it logged', () => {
    const status = hostMachineStatus({
      ...ON,
      process: { kind: 'stopped', state: 'exited', code: 2, log: 'bad bundle' },
    });
    expect(status).toMatchObject({ label: 'Stopped', tone: 'error' });
    expect(status.detail).toContain('configuration error');
    expect(status.detail).toContain('bad bundle');
    expect(
      hostMachineStatus({ ...ON, process: { kind: 'stopped', state: 'exited', code: 3, log: '' } })
        .label
    ).toBe('Removed');
  });

  it('says a controller whose process went away is not running, never that it is', () => {
    const rebooted: HostControllerOverview = {
      ...ON,
      enrollment: { ...ON.enrollment!, supervision: 'detached' },
      process: {
        kind: 'stopped',
        state: 'gone',
        code: null,
        log: 'INFO Started agent {"agentId":"agent-1"}',
      },
    };
    const status = hostMachineStatus(rebooted);
    expect(status).toMatchObject({ label: 'Stopped', tone: 'error' });
    expect(status.detail).toBe(
      'The controller is not running. Its process is gone without saying why: the host may have restarted, or the process was killed.\n' +
        'The last lines it logged:\nINFO Started agent {"agentId":"agent-1"}'
    );
    expect(canRestartHost(rebooted)).toBe(true);
    for (const state of ['running', 'restarting', 'active'])
      expect(
        hostMachineStatus({ ...ON, process: { kind: 'stopped', state, code: null, log: '' } })
          .detail
      ).not.toMatch(/It is running|reports it running|reports it active/);
  });

  it('says what the supervisor reports for the other ways it stops', () => {
    const detail = (state: string, code: number | null = null) =>
      hostMachineStatus({ ...ON, process: { kind: 'stopped', state, code, log: '' } }).detail;
    expect(detail('stopped')).toBe('The controller is not running. It was stopped.');
    expect(detail('never-started')).toBe(
      'The controller is not running. It has not been started on this host.'
    );
    expect(detail('exited', 0)).toBe('The controller is not running. It exited with code 0.');
    expect(detail('failed', 1)).toBe(
      'The controller is not running. systemd reports that it failed.'
    );
  });

  it('does not claim to know when the host cannot be asked', () => {
    expect(
      hostMachineStatus({ ...ON, process: { kind: 'unknown', reason: 'unreachable' } })
    ).toEqual({
      label: 'Unknown',
      tone: 'warn',
      detail: 'Console cannot tell whether the controller runs: unreachable',
    });
  });

  it('is disconnected while the controller has not reached Switch', () => {
    expect(
      hostMachineStatus({
        ...ON,
        remote: { kind: 'ok', controller: { state: 'unknown', lastSeenAt: null }, agents: [] },
      })
    ).toMatchObject({ label: 'Disconnected', tone: 'warn' });
  });

  it('says how it is kept running', () => {
    expect(supervisionNote(ON)).toContain('systemd');
    expect(
      supervisionNote({ ...ON, enrollment: { ...ON.enrollment!, supervision: 'detached' } })
    ).toContain('Start again');
    expect(supervisionNote(OFF)).toBeNull();
  });
});

describe('the toggle', () => {
  it('needs a server with agent management to turn on', () => {
    expect(hostToggleBlocker(OFF)).toBeNull();
    expect(hostToggleBlocker({ ...OFF, remote: { kind: 'unavailable' } })).toMatch(
      /agent management/
    );
    expect(hostToggleBlocker({ ...OFF, remote: null })).toMatch(/workspace/);
  });

  it('needs the agents moved from this Console back before turning off', () => {
    expect(hostToggleBlocker(ON)).toBeNull();
    expect(hostToggleBlocker({ ...ON, movedAgents: ['builder'] })).toMatch(/builder/);
  });

  it('is held while setting up or removing', () => {
    expect(hostToggleBlocker({ ...ON, phase: { kind: 'removing' } })).toBe('Working…');
  });
});

describe('starting it again', () => {
  it('is offered for a stopped controller, but not a revoked one', () => {
    expect(canRestartHost(ON)).toBe(false);
    expect(
      canRestartHost({ ...ON, process: { kind: 'stopped', state: 'exited', code: 1, log: '' } })
    ).toBe(true);
    expect(
      canRestartHost({ ...ON, process: { kind: 'stopped', state: 'exited', code: 3, log: '' } })
    ).toBe(false);
  });
});

describe('the managed agents placed on the host', () => {
  const AGENT: PlacedManagedAgent = {
    agentId: 'agent-1',
    name: 'builder',
    displayName: null,
    provider: 'claude',
    desiredState: 'running',
    actual: { process: 'running', attached: true, reason: null, detail: 'pid 4242' },
  };

  it('read as the controller reports them while it runs', () => {
    expect(hostAgentActual(ON, AGENT)).toEqual({
      label: 'running',
      tone: 'ok',
      detail: 'pid 4242',
    });
  });

  it('read as not running while the controller is stopped, whatever they last reported', () => {
    const stopped: HostControllerOverview = {
      ...ON,
      process: { kind: 'stopped', state: 'gone', code: null, log: '' },
    };
    expect(hostAgentActual(stopped, AGENT)).toEqual({
      label: 'not running',
      tone: 'warn',
      detail: 'the controller is not running',
    });
    expect(hostAgentActual(stopped, { ...AGENT, desiredState: 'stopped' }).tone).toBe('neutral');
  });

  it('read as unknown while Console cannot tell whether the controller runs', () => {
    expect(
      hostAgentActual({ ...ON, process: { kind: 'unknown', reason: 'unreachable' } }, AGENT)
    ).toMatchObject({ label: 'unknown', tone: 'warn' });
  });
});

describe('a failure shown on the card', () => {
  it('outlives a re-read of the same state, not a change of it', () => {
    const refusedIn = hostStateKey({ ...ON, movedAgents: ['builder'] });
    expect(hostStateKey({ ...ON, movedAgents: ['builder'] })).toBe(refusedIn);
    expect(hostStateKey(ON)).not.toBe(refusedIn);
    expect(
      hostStateKey({
        ...ON,
        movedAgents: ['builder'],
        process: { kind: 'stopped', state: 'gone', code: null, log: '' },
      })
    ).not.toBe(refusedIn);
  });

  it('is not repeated when the status line already shows it', () => {
    const failed: HostControllerOverview = {
      ...ON,
      phase: { kind: 'error', message: 'build-box runs Node 20.11.0.' },
    };
    expect(failureAlreadyShown(failed, 'build-box runs Node 20.11.0.')).toBe(true);
    expect(failureAlreadyShown(failed, 'Switch is down.')).toBe(false);
    expect(failureAlreadyShown(ON, 'build-box runs Node 20.11.0.')).toBe(false);
  });
});

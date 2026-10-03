import { describe, expect, it } from 'vitest';
import type { HostControllerOverview } from '@shared/core/host-controllers/host-controllers';
import {
  canRestartHost,
  hostMachineStatus,
  hostToggleBlocker,
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

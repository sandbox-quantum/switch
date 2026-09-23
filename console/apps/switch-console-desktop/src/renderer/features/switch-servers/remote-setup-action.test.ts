import { describe, expect, it } from 'vitest';
import { remoteSetupAction } from './remote-setup-action';

describe('remoteSetupAction', () => {
  it('offers nothing until the host has been looked at', () => {
    expect(remoteSetupAction('vm-1', null, false)).toEqual({ kind: 'checking' });
    expect(remoteSetupAction('vm-1', { kind: 'absent' }, true)).toEqual({ kind: 'checking' });
  });

  it('offers to join a running stack rather than start it again', () => {
    expect(
      remoteSetupAction(
        'vm-1',
        { kind: 'present', running: true, deployedVersion: '0.27.0', shared: false },
        false
      )
    ).toEqual({ kind: 'connect', deployedVersion: '0.27.0', shared: false });
  });

  it('offers to start a stopped stack, keeping what it has', () => {
    expect(
      remoteSetupAction(
        'vm-1',
        { kind: 'present', running: false, deployedVersion: '0.27.0', shared: true },
        false
      )
    ).toEqual({ kind: 'start', existing: true });
  });

  it('offers to set one up on an empty host', () => {
    expect(remoteSetupAction('vm-1', { kind: 'absent' }, false)).toEqual({
      kind: 'start',
      existing: false,
    });
  });

  it('offers nothing on another account’s unshared stack, and says why', () => {
    expect(
      remoteSetupAction(
        'vm-1',
        { kind: 'unshared', running: true, ownerDir: null, message: 'set up from another account' },
        false
      )
    ).toEqual({
      kind: 'blocked',
      title: 'The server on vm-1 belongs to another account',
      detail: 'set up from another account',
    });
  });

  it('offers nothing when the stack’s settings are partial', () => {
    const action = remoteSetupAction(
      'vm-1',
      { kind: 'incomplete', running: false, missing: ['JWT_SECRET_KEY'] },
      false
    );

    expect(action.kind).toBe('blocked');
    expect(action.kind === 'blocked' && action.detail).toMatch(/missing JWT_SECRET_KEY/);
  });

  it('offers nothing on a host it could not read, rather than guessing it is empty', () => {
    expect(remoteSetupAction('vm-1', { kind: 'unreadable', reason: 'ssh dropped' }, false)).toEqual(
      { kind: 'blocked', title: 'Could not check vm-1 for a Switch server', detail: 'ssh dropped' }
    );
  });

  it('leaves Docker being unavailable to the Docker notice', () => {
    expect(
      remoteSetupAction(
        'vm-1',
        { kind: 'docker-unavailable', reason: 'daemon-down', detail: 'no daemon' },
        false
      )
    ).toEqual({ kind: 'docker' });
  });
});

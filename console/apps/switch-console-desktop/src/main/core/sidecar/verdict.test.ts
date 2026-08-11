import { describe, expect, it } from 'vitest';
import type { SidecarRunStatus } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { verdictFor } from './verdict';

const CLIENT = 'client-hash';
const CLIENT_VERSION = '1.7.0';

const status = (over: Partial<SidecarRunStatus>): SidecarRunStatus => ({
  running: true,
  compatible: true,
  hash: CLIENT,
  version: CLIENT_VERSION,
  contract: { speaks: 1, accepts: 1 },
  epoch: 1,
  pid: 100,
  liveSessions: 0,
  ...over,
});

const verdict = (over: Partial<SidecarRunStatus>) =>
  verdictFor(status(over), CLIENT, CLIENT_VERSION);

describe('verdictFor', () => {
  it('not-running when nothing is up', () => {
    expect(verdict({ running: false })).toBe('not-running');
  });

  it('up-to-date when the host runs this exact build', () => {
    expect(verdict({ hash: CLIENT })).toBe('up-to-date');
  });

  it('upgrade-available when a different build of the same version is idle', () => {
    expect(verdict({ hash: 'other', liveSessions: 0 })).toBe('upgrade-available');
  });

  it('upgrade-available when the host runs an older version', () => {
    expect(verdict({ hash: 'other', version: '1.6' })).toBe('upgrade-available');
  });

  it('upgrade-pending when a different build is running but busy', () => {
    expect(verdict({ hash: 'other', liveSessions: 3 })).toBe('upgrade-pending');
  });

  it('newer-on-host rather than offering a downgrade', () => {
    // A newer Switch Console deployed it. Offering "Update" here is an invitation to
    // downgrade, and on a shared host both installs would accept it in turn.
    expect(verdict({ hash: 'other', version: '1.8' })).toBe('newer-on-host');
  });

  it('newer-on-host outranks the live-session check', () => {
    // Busy or idle, there is still nothing this client should do about it.
    expect(verdict({ hash: 'other', version: '2.0', liveSessions: 4 })).toBe('newer-on-host');
  });

  it('incompatible outranks any build comparison', () => {
    // Even the same hash is moot if we cannot speak its protocol — though in
    // practice an incompatible sidecar is a different build anyway.
    expect(verdict({ compatible: false, hash: 'other', liveSessions: 5 })).toBe('incompatible');
  });
});

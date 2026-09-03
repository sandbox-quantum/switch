import { describe, expect, it } from 'vitest';
import type { SidecarRunStatus } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { verdictFor } from './verdict';

const CLIENT = 'client-hash';
const CLIENT_VERSION = '1.7.0';
const CLIENT_DEPLOYER = 'install-a';

const status = (over: Partial<SidecarRunStatus>): SidecarRunStatus => ({
  running: true,
  compatible: true,
  hash: CLIENT,
  version: CLIENT_VERSION,
  contract: { speaks: 1, accepts: 1 },
  epoch: 1,
  pid: 100,
  deployerId: CLIENT_DEPLOYER,
  liveSessions: 0,
  ...over,
});

const verdict = (over: Partial<SidecarRunStatus>) =>
  verdictFor(status(over), {
    hash: CLIENT,
    version: CLIENT_VERSION,
    deployerId: CLIENT_DEPLOYER,
  });

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

  it('upgrade-available when a busy sidecar is only a build behind', () => {
    // Live sessions survive the restart, so they no longer hold an upgrade back.
    expect(verdict({ hash: 'other', liveSessions: 3 })).toBe('upgrade-available');
  });

  it('upgrade-pending when a busy sidecar is a MAJOR behind', () => {
    expect(verdict({ hash: 'other', version: '0.9', liveSessions: 3 })).toBe('upgrade-pending');
  });

  it('upgrade-available for a major bump once the sidecar is idle', () => {
    expect(verdict({ hash: 'other', version: '0.9', liveSessions: 0 })).toBe('upgrade-available');
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

  it("other-install when the same version's build belongs to another install", () => {
    // Version ordering cannot separate them and the hash says which build, never
    // whose — so without this both installs read the other as an upgrade.
    expect(verdict({ hash: 'other', deployerId: 'install-b' })).toBe('other-install');
  });

  it('other-install outranks the live-session check', () => {
    // Not a deferred upgrade: there is no upgrade here to defer.
    expect(verdict({ hash: 'other', deployerId: 'install-b', liveSessions: 3 })).toBe(
      'other-install'
    );
  });

  it('upgrade-available for our own earlier build — the local rebuild loop', () => {
    expect(verdict({ hash: 'other', deployerId: CLIENT_DEPLOYER })).toBe('upgrade-available');
  });

  it('upgrade-available for a sidecar deployed before installs identified themselves', () => {
    // Unknown, not foreign. One deploy stamps an id and the trading stops after
    // a single round rather than nothing ever being upgraded again.
    expect(verdict({ hash: 'other', deployerId: null })).toBe('upgrade-available');
  });

  it('still replaces another install’s OLDER build — version ordering wins first', () => {
    // Yielding is only for the tie. An older sidecar is replaceable no matter
    // who deployed it, which is what keeps CHOO-1937 working.
    expect(verdict({ hash: 'other', version: '1.6', deployerId: 'install-b' })).toBe(
      'upgrade-available'
    );
  });

  it("newer-on-host outranks another install's identity", () => {
    expect(verdict({ hash: 'other', version: '1.8', deployerId: 'install-b' })).toBe(
      'newer-on-host'
    );
  });

  it('up-to-date when another install deployed this exact build', () => {
    // Same bytes: whose they are makes no difference to anything.
    expect(verdict({ hash: CLIENT, deployerId: 'install-b' })).toBe('up-to-date');
  });

  it('incompatible outranks any build comparison', () => {
    // Even the same hash is moot if we cannot speak its protocol — though in
    // practice an incompatible sidecar is a different build anyway.
    expect(verdict({ compatible: false, hash: 'other', liveSessions: 5 })).toBe('incompatible');
  });
});

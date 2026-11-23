import { describe, expect, it } from 'vitest';
import { controllerReserveFromEnv, DEFAULT_CONTROLLER_RESERVE_BYTES } from './controller-reserve';
import { isSplitBox, splitFlagsProblem } from './split-flags';

const split = {
  agentRuntime: 'default',
  launcherSocket: '/run/switch/launcher.sock',
  agentsDataDir: '/data/agents',
  agentsWorkspaces: '/data/agents/workspaces',
  testBox: false,
  operatorExec: false,
};
const gateway = { SWITCH_CONTROLLER_PROVIDER_GATEWAY: '1' };

describe('the split-mode flags', () => {
  it('accepts a split box with the gateway on, and any box without split mode', () => {
    expect(splitFlagsProblem(split, gateway)).toBeNull();
    expect(splitFlagsProblem({ ...split, launcherSocket: undefined }, {})).toBeNull();
  });

  it('refuses split mode without the gateway, the agents’ folders, or with per-agent users', () => {
    expect(splitFlagsProblem(split, {})).toMatch('provider gateway');
    expect(splitFlagsProblem({ ...split, agentsWorkspaces: undefined }, gateway)).toMatch(
      '--agents-workspaces'
    );
    expect(splitFlagsProblem({ ...split, agentRuntime: 'separate-user' }, gateway)).toMatch(
      'users of their own'
    );
  });

  it('refuses operator exec unless the template marks a split box as a test box', () => {
    expect(splitFlagsProblem({ ...split, operatorExec: true }, gateway)).toMatch('test boxes only');
    expect(
      splitFlagsProblem(
        { ...split, launcherSocket: undefined, testBox: true, operatorExec: true },
        gateway
      )
    ).toMatch('test boxes only');
    expect(splitFlagsProblem({ ...split, testBox: true, operatorExec: true }, gateway)).toBeNull();
  });

  it('takes loopback inside the pod instead of a socket, and nothing wider', () => {
    const loopback = { ...split, launcherSocket: undefined, launcherAddress: '127.0.0.1:7420' };
    expect(splitFlagsProblem(loopback, gateway)).toBeNull();
    expect(splitFlagsProblem({ ...loopback, launcherAddress: '0.0.0.0:7420' }, gateway)).toMatch(
      'must be 127.0.0.1:<port>'
    );
    expect(splitFlagsProblem({ ...split, launcherAddress: '127.0.0.1:7420' }, gateway)).toMatch(
      'give one'
    );
    // The other split rules apply to loopback too.
    expect(splitFlagsProblem(loopback, {})).toMatch('provider gateway');
    expect(
      splitFlagsProblem({ ...loopback, testBox: true, operatorExec: true }, gateway)
    ).toBeNull();
  });

  it('refuses loopback that a proxy could carry: NO_PROXY must name it', () => {
    const loopback = { ...split, launcherSocket: undefined, launcherAddress: '127.0.0.1:7420' };
    const proxied = { ...gateway, HTTPS_PROXY: 'http://squid:3128' };
    expect(splitFlagsProblem(loopback, proxied)).toMatch('NO_PROXY');
    expect(splitFlagsProblem(loopback, { ...proxied, NO_PROXY: 'localhost' })).toBeNull();
  });

  it('calls a box split for either the loopback address or the socket, and only then', () => {
    expect(isSplitBox({ launcherAddress: '127.0.0.1:7420' })).toBe(true);
    expect(isSplitBox({ launcherSocket: '/run/switch/launcher.sock' })).toBe(true);
    expect(isSplitBox({})).toBe(false);
    expect(isSplitBox({ launcherSocket: undefined, launcherAddress: undefined })).toBe(false);
  });

  it('gives a loopback box the controller reserve as a split box, as main does', () => {
    const errors: string[] = [];
    const reserve = (flags: { launcherSocket?: string; launcherAddress?: string }) =>
      controllerReserveFromEnv(
        {},
        {
          split: isSplitBox(flags),
          podLimit: 6 * 1024 * 1024 * 1024,
          log: { error: (line: string) => void errors.push(line), warn: () => {} },
        }
      );
    // None set: a loopback box keeps the 256 MiB default (with its one ERROR), as a socket box does.
    expect(reserve({ launcherAddress: '127.0.0.1:7420' })).toBe(DEFAULT_CONTROLLER_RESERVE_BYTES);
    expect(reserve({ launcherSocket: '/run/switch/launcher.sock' })).toBe(
      DEFAULT_CONTROLLER_RESERVE_BYTES
    );
    expect(errors).toHaveLength(2);
    // Not split: nothing reserved, nothing said.
    expect(reserve({})).toBe(0);
    expect(errors).toHaveLength(2);
  });
});

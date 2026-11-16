import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowInPolicy,
  changeDevicePolicy,
  DEVICE_POLICY_FILE,
  disallowInPolicy,
  emptyDevicePolicy,
  EVERY_AGENT,
  isDeviceConsentNeededMessage,
  policyAllowsBypass,
  policyAllowsDirectory,
  readDevicePolicy,
  writeDevicePolicy,
} from './device-policy';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'device-policy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the device policy', () => {
  it('allows nothing until something is allowed, and keeps the file to its owner', async () => {
    expect(await readDevicePolicy(dir)).toEqual(emptyDevicePolicy());
    const policy = allowInPolicy(emptyDevicePolicy(), 'agent-1', {
      bypass: true,
      directory: '/srv/repos',
    });
    await writeDevicePolicy(dir, policy);
    expect(await readDevicePolicy(dir)).toEqual(policy);
    if (process.platform !== 'win32')
      expect((await stat(join(dir, DEVICE_POLICY_FILE))).mode & 0o777).toBe(0o600);
  });

  it('lands every one of several changes made at once, a revocation among them', async () => {
    await writeDevicePolicy(
      dir,
      allowInPolicy(emptyDevicePolicy(), 'agent-0', { bypass: true, directory: null })
    );
    const agents = Array.from({ length: 8 }, (_, index) => `agent-${index + 1}`);
    await Promise.all([
      changeDevicePolicy(dir, (policy) => disallowInPolicy(policy, 'agent-0', 'all')),
      ...agents.map((agentId) =>
        changeDevicePolicy(dir, (policy) =>
          allowInPolicy(policy, agentId, { bypass: true, directory: null })
        )
      ),
    ]);
    const policy = await readDevicePolicy(dir);
    expect(Object.keys(policy.agents).sort()).toEqual(agents);
    expect(agents.every((agentId) => policyAllowsBypass(policy, agentId))).toBe(true);
  });

  it('writes nothing when a change throws, and leaves the next change free to go ahead', async () => {
    await expect(
      changeDevicePolicy(dir, () => {
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect(await readDevicePolicy(dir)).toEqual(emptyDevicePolicy());
    const written = await changeDevicePolicy(dir, (policy) =>
      allowInPolicy(policy, 'agent-1', { bypass: true, directory: null })
    );
    expect(await readDevicePolicy(dir)).toEqual(written);
  });

  it('refuses a file it cannot read as a policy rather than reading it as allowing nothing', async () => {
    await writeFile(
      join(dir, DEVICE_POLICY_FILE),
      JSON.stringify({ version: 1, agents: { a: { bypass: 'yes' } } })
    );
    await expect(readDevicePolicy(dir)).rejects.toThrow(/not a device policy/);
  });

  it('allows an agent its own grants, and every agent the ones given to all', () => {
    let policy = allowInPolicy(emptyDevicePolicy(), 'agent-1', {
      bypass: false,
      directory: '/srv/repos',
    });
    expect(policyAllowsDirectory(policy, 'agent-1', '/srv/repos/app')).toBe(true);
    expect(policyAllowsDirectory(policy, 'agent-1', '/srv/repos')).toBe(true);
    expect(policyAllowsDirectory(policy, 'agent-1', '/srv/repos-other')).toBe(false);
    expect(policyAllowsDirectory(policy, 'agent-2', '/srv/repos/app')).toBe(false);
    expect(policyAllowsBypass(policy, 'agent-1')).toBe(false);
    policy = allowInPolicy(policy, EVERY_AGENT, { bypass: true, directory: null });
    expect(policyAllowsBypass(policy, 'agent-2')).toBe(true);
  });

  it('takes back one grant, or everything an agent was given', () => {
    let policy = allowInPolicy(emptyDevicePolicy(), 'agent-1', {
      bypass: true,
      directory: '/srv/a',
    });
    policy = allowInPolicy(policy, 'agent-1', { bypass: false, directory: '/srv/b' });
    policy = disallowInPolicy(policy, 'agent-1', { bypass: true, directory: '/srv/a' });
    expect(policy.agents['agent-1']).toEqual({ directories: [resolve('/srv/b')] });
    expect(disallowInPolicy(policy, 'agent-1', 'all')).toEqual(emptyDevicePolicy());
  });

  it('refuses a relative directory', () => {
    expect(() =>
      allowInPolicy(emptyDevicePolicy(), 'agent-1', { bypass: false, directory: 'repos' })
    ).toThrow(/not an absolute path/);
  });

  it('reads what a controller tells Console waits on the device', () => {
    expect(
      isDeviceConsentNeededMessage({
        kind: 'switch-device-consent-needed',
        needs: [{ agentId: 'a', name: 'scout', displayName: null, bypass: true, directory: null }],
      })
    ).toBe(true);
    expect(isDeviceConsentNeededMessage({ kind: 'switch-device-consent-needed' })).toBe(false);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertCurrentOwnershipMachine,
  currentHostedMachineIdentity,
  ownershipRecord,
} from './ownership-lock';
import { withOwnershipLock } from './ownership-lock';

const roots: string[] = [];
const current = {
  instanceId: 'i-0123456789abcdef0',
  bootId: '11111111-1111-4111-8111-111111111111',
  assignmentGeneration: 7,
};

function setIdentity(identity = current): void {
  vi.stubEnv('SWITCH_HOST_INSTANCE_ID', identity.instanceId);
  vi.stubEnv('SWITCH_HOST_BOOT_ID', identity.bootId);
  vi.stubEnv('SWITCH_HOST_ASSIGNMENT_GENERATION', String(identity.assignmentGeneration));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('requires the complete trusted hosted identity environment', () => {
  expect(() => assertCurrentOwnershipMachine(current)).toThrow('another machine boot');
  vi.stubEnv('SWITCH_HOST_INSTANCE_ID', current.instanceId);
  expect(() => currentHostedMachineIdentity()).toThrow('incomplete');
  setIdentity();
  expect(currentHostedMachineIdentity()).toEqual(current);
  expect(ownershipRecord({ pid: 1 })).toEqual({ pid: 1, machine: current });
});

it('rejects malformed and mismatched boot identity', () => {
  setIdentity();
  expect(() =>
    assertCurrentOwnershipMachine({ ...current, bootId: '22222222-2222-4222-8222-222222222222' })
  ).toThrow('another machine boot');
  vi.stubEnv('SWITCH_HOST_ASSIGNMENT_GENERATION', 'not-a-number');
  expect(() => currentHostedMachineIdentity()).toThrow('invalid');
});

it('checks a bakery ticket boot before consulting its reusable PID', async () => {
  setIdentity();
  const root = await mkdtemp(join(tmpdir(), 'hosted-machine-owner-'));
  roots.push(root);
  const directory = join(root, 'ownership');
  await mkdir(directory);
  await writeFile(
    join(directory, String(process.pid) + '-11111111-1111-4111-8111-111111111111.json'),
    JSON.stringify({
      choosing: false,
      ticket: 1,
      machine: {
        ...current,
        bootId: '22222222-2222-4222-8222-222222222222',
      },
    })
  );
  await expect(withOwnershipLock(root, async () => {})).rejects.toThrow('another machine boot');
});

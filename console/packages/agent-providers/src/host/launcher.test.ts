import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectHost } from './launcher';

const realPlatform = process.platform;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: realPlatform });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A host root whose `owner.lock` names a pid that answers EPERM, and a host that cannot start. */
async function lockedByForeignPid(platform: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-host-launcher-'));
  roots.push(root);
  await writeFile(join(root, 'owner.lock'), '4242');
  Object.defineProperty(process, 'platform', { value: platform });
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid !== 4242) return true;
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  const launch = connectHost(root, join(root, 'missing-node'), join(root, 'host.mjs'), {});
  await expect(launch).rejects.toMatchObject({ code: 'ENOENT' });
  return join(root, 'owner.lock');
}

it.each<NodeJS.Platform>(['linux', 'darwin'])(
  'clears an owner lock whose pid now belongs to another user on %s',
  async (platform) => {
    expect(existsSync(await lockedByForeignPid(platform))).toBe(false);
  }
);

it('keeps an owner lock whose pid it may not signal on Windows', async () => {
  expect(existsSync(await lockedByForeignPid('win32'))).toBe(true);
});

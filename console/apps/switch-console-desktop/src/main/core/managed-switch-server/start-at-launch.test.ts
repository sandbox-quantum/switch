import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readStartAtLaunch, writeStartAtLaunch } from './start-at-launch';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'start-at-launch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('starts a server that has never said either way', async () => {
  await expect(readStartAtLaunch(dir)).resolves.toBe(true);
});

it('reads back what was written', async () => {
  await writeStartAtLaunch(dir, false);
  await expect(readStartAtLaunch(dir)).resolves.toBe(false);
  await writeStartAtLaunch(dir, true);
  await expect(readStartAtLaunch(dir)).resolves.toBe(true);
});

it('writes into a folder that does not exist yet', async () => {
  const nested = path.join(dir, 'local-switch-server');
  await writeStartAtLaunch(nested, false);
  await expect(readStartAtLaunch(nested)).resolves.toBe(false);
});

it('refuses a file that does not say', async () => {
  await writeFile(path.join(dir, 'start-at-launch.json'), '{"startAtLaunch":"yes"}');
  await expect(readStartAtLaunch(dir)).rejects.toThrow('does not say whether');
});

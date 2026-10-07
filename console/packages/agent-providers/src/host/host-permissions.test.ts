import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { dirMode, fileMode, shareLoginDirectory, sharedGroupEnabled } from './host-permissions';
import type { HostedCredential } from './hosted-provider';
import { materializeHostedProvider } from './hosted-provider';
import { replaceOwner } from './ownership-lock';
import { recordTakenOver } from './taken-over';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('keeps state private to its user by default', () => {
  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '');
  expect(sharedGroupEnabled()).toBe(false);
  expect(fileMode()).toBe(0o600);
  expect(fileMode(0o700)).toBe(0o700);
  expect(dirMode()).toBe(0o700);
});

it('opens state to the group for reading under the shared group', () => {
  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '1');
  expect(sharedGroupEnabled()).toBe(true);
  expect(fileMode()).toBe(0o640);
  expect(fileMode(0o700)).toBe(0o750);
  expect(dirMode()).toBe(0o2750);
});

it('only the exact value 1 turns the shared group on', () => {
  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', 'true');
  expect(fileMode()).toBe(0o600);
});

it('writes owner and standing-down records group-readable under the shared group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-permissions-'));
  roots.push(root);
  const takenOver = { at: '2026-01-01T00:00:00Z', reason: 'test', connectionId: 'connection' };

  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '');
  await replaceOwner(join(root, 'private.json'), { pid: 1 });
  expect((await stat(join(root, 'private.json'))).mode & 0o777).toBe(0o600);

  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '1');
  await replaceOwner(join(root, 'shared.json'), { pid: 1 });
  await recordTakenOver(root, takenOver);
  expect((await stat(join(root, 'shared.json'))).mode & 0o777).toBe(0o640);
  expect((await stat(join(root, 'taken-over.json'))).mode & 0o777).toBe(0o640);
});

it('lets the group remove a provider login only under the shared group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-permissions-'));
  roots.push(root);
  const credential: HostedCredential = {
    status: 'connected',
    revision: '1',
    provider: 'antigravity',
    kind: 'auth-json',
    credential: '{"token":"placeholder"}',
  };

  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '');
  await materializeHostedProvider(join(root, 'private'), {}, credential, '/bin/false');
  expect((await stat(join(root, 'private/provider-home/antigravity-acp'))).mode & 0o070).toBe(0);

  vi.stubEnv('SWITCH_HOST_SHARED_GROUP', '1');
  await mkdir(join(root, 'shared/provider-home'), { recursive: true });
  await chmod(join(root, 'shared/provider-home'), 0o700);
  await materializeHostedProvider(join(root, 'shared'), {}, credential, '/bin/false');
  for (const directory of ['provider-home', 'provider-home/antigravity-acp'])
    expect((await stat(join(root, 'shared', directory))).mode & 0o070).toBe(0o070);
  await expect(shareLoginDirectory(join(root, 'missing'))).rejects.toThrow();
});

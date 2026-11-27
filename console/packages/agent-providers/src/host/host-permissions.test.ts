import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirMode, ensurePrivateDirectory, fileMode, SHARED_GROUP_ENV } from './host-permissions';

const roots: string[] = [];
afterEach(async () => {
  delete process.env[SHARED_GROUP_ENV];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'host-permissions-'));
  roots.push(root);
  return root;
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe('host permissions', () => {
  it('keeps what an agent host writes private by default', () => {
    expect(fileMode(0o600)).toBe(0o600);
    expect(dirMode(0o700)).toBe(0o700);
  });

  it('opens it to the group under the shared group, with no set-id bit', () => {
    process.env[SHARED_GROUP_ENV] = '1';
    expect(fileMode(0o600)).toBe(0o640);
    expect(dirMode(0o700)).toBe(0o770);
  });
});

describe.skipIf(process.platform === 'win32')('ensurePrivateDirectory', () => {
  it('creates the directory and its missing parents 0700 whatever the umask', async () => {
    const root = await scratch();
    const umask = process.umask(0o022);
    try {
      await ensurePrivateDirectory(join(root, 'state', 'sdk-sessions'));
    } finally {
      process.umask(umask);
    }
    expect(await modeOf(join(root, 'state'))).toBe(0o700);
    expect(await modeOf(join(root, 'state', 'sdk-sessions'))).toBe(0o700);
  });

  it('tightens one an earlier build left open, and says so', async () => {
    const root = await scratch();
    const open = join(root, 'session');
    await mkdir(open);
    await chmod(open, 0o755);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ensurePrivateDirectory(open);
    expect(await modeOf(open)).toBe(0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(mode 755); made it 700'));
  });

  it('leaves a private one alone, and gives the group its share under the shared group', async () => {
    const root = await scratch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ensurePrivateDirectory(join(root, 'private'));
    await ensurePrivateDirectory(join(root, 'private'));
    process.env[SHARED_GROUP_ENV] = '1';
    await ensurePrivateDirectory(join(root, 'private'));
    expect(await modeOf(join(root, 'private'))).toBe(0o700);
    const shared = join(root, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o775);
    await ensurePrivateDirectory(shared);
    expect(await modeOf(shared)).toBe(0o770);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

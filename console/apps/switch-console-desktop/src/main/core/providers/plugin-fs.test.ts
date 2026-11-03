import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginFs } from './plugin-fs';

/**
 * Against a real temp directory rather than a mocked `node:fs`: the behaviour
 * under test is which errno values are treated as "already absent", and a mock
 * would just restate the implementation's own answer.
 */
describe('createPluginFs delete', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'plugin-fs-'));
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('removes an existing file', async () => {
    const fs = createPluginFs(root);
    await writeFile(path.join(root, 'creds.json'), '{}');

    await fs.delete('creds.json');

    expect(await fs.exists('creds.json')).toBe(false);
  });

  it('resolves when the file is already gone', async () => {
    const fs = createPluginFs(root);
    await expect(fs.delete('never-existed.json')).resolves.toBeUndefined();
  });

  it('resolves when a parent path segment is not a directory', async () => {
    // ENOTDIR: the file equally does not exist, same reasoning as read().
    const fs = createPluginFs(root);
    await writeFile(path.join(root, 'afile'), 'x');
    await expect(fs.delete('afile/nested.json')).resolves.toBeUndefined();
  });

  it('throws (fails loud) when the file exists but cannot be removed', async () => {
    // A silently-swallowed failure here reports an agent's Switch token as
    // revoked while it is still readable on disk.
    const fs = createPluginFs(root);
    const locked = path.join(root, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'token.json'), 'secret');
    await chmod(locked, 0o500); // r-x: the entry cannot be unlinked

    await expect(fs.delete('locked/token.json')).rejects.toThrow();

    await chmod(locked, 0o700);
  });

  it('throws on a path escape instead of silently doing nothing', async () => {
    const fs = createPluginFs(root);
    await expect(fs.delete('../outside.json')).rejects.toThrow(/path escape/);
  });
});

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe.skipIf(process.platform === 'win32')('createPluginFs secret write', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'plugin-fs-secret-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the file 0600 in a 0700 directory whatever the umask, leaving nothing else', async () => {
    const previous = process.umask(0o022);
    try {
      await createPluginFs(root).write('.switch/agents/a.json', 'token', { secret: true });
    } finally {
      process.umask(previous);
    }

    const dir = path.join(root, '.switch', 'agents');
    expect(await readFile(path.join(dir, 'a.json'), 'utf8')).toBe('token');
    expect(await modeOf(path.join(dir, 'a.json'))).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('replaces a file and tightens a directory an earlier version left open', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, 'a.json'), 'old', { mode: 0o644 });

    await createPluginFs(root).write('.switch/agents/a.json', 'new', { secret: true });

    expect(await readFile(path.join(dir, 'a.json'), 'utf8')).toBe('new');
    expect(await modeOf(path.join(dir, 'a.json'))).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('removes its temporary file and throws when the target cannot be replaced', async () => {
    // A directory where the file should be: the rename over it fails.
    await mkdir(path.join(root, 'secrets', 'a.json'), { recursive: true });

    await expect(
      createPluginFs(root).write('secrets/a.json', 'token', { secret: true })
    ).rejects.toThrow();

    expect(await readdir(path.join(root, 'secrets'))).toEqual(['a.json']);
  });

  it('refuses a path escape', async () => {
    await expect(
      createPluginFs(root).write('../outside.json', 'token', { secret: true })
    ).rejects.toThrow(/path escape/);
  });
});

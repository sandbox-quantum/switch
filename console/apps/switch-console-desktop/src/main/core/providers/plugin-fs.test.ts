import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

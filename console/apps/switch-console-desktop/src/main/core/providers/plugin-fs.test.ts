import { promises as nodeFs } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginFs } from './plugin-fs';

const acl = vi.hoisted(() => ({
  directory: vi.fn(async (_path: string) => {}),
  file: vi.fn(async (_path: string) => {}),
}));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@main/core/fs/windows-owner-acl', () => ({
  restrictWindowsDirectoryToOwner: acl.directory,
  restrictWindowsFileToOwner: acl.file,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn } }));

/** Make `chmod` of `target` fail with `code`, as it does for a path another account owns. */
function refuseChmod(target: string, code: string) {
  const real = nodeFs.chmod;
  return vi.spyOn(nodeFs, 'chmod').mockImplementation(async (p, mode) => {
    if (p === target) throw Object.assign(new Error(`${code}: chmod '${target}'`), { code });
    return real(p, mode);
  });
}

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

  it('removes the copies an interrupted secret write left, and nothing else', async () => {
    // A secret write renames `<file>.<uuid>` into place; cut off first, the copy
    // holds the same token, and deleting the agent must not leave it behind.
    const fs = createPluginFs(root);
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    const uuid = '0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5';
    for (const name of [
      'a.json',
      `a.json.${uuid}`,
      `a.json.${uuid.replace('0b6f', '1c7a')}`,
      'a.json.bak',
      `a.json2.${uuid}`,
      `b.json.${uuid}`,
    ]) {
      await writeFile(path.join(dir, name), 'token');
    }

    await fs.delete('.switch/agents/a.json');

    expect((await readdir(dir)).sort()).toEqual([
      'a.json.bak',
      `a.json2.${uuid}`,
      `b.json.${uuid}`,
    ]);
  });

  it('removes a leftover copy when the file itself was never written', async () => {
    const fs = createPluginFs(root);
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'a.json.0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5'), 'token');

    await fs.delete('.switch/agents/a.json');

    expect(await readdir(dir)).toEqual([]);
  });
});

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe.skipIf(process.platform === 'win32')('createPluginFs secret write', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'plugin-fs-secret-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    warn.mockClear();
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

  it('protects an existing file and its directory without touching the content', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, 'a.json'), 'token', { mode: 0o644 });
    const before = await stat(path.join(dir, 'a.json'));

    expect(await createPluginFs(root).protectSecret('.switch/agents/a.json')).toBe(true);

    const after = await stat(path.join(dir, 'a.json'));
    expect(after.mode & 0o777).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o700);
    // The same file, not a replacement: nothing a concurrent writer did is undone.
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path.join(dir, 'a.json'), 'utf8')).toBe('token');
  });

  it('leaves the directory alone and says so when there is no file to protect', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);

    expect(await createPluginFs(root).protectSecret('.switch/agents/a.json')).toBe(false);
    expect(await createPluginFs(root).protectSecret('missing/a.json')).toBe(false);

    expect(await modeOf(dir)).toBe(0o755);
  });

  it('writes the file 0600 and warns when its directory belongs to another account', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    refuseChmod(dir, 'EPERM');

    await createPluginFs(root).write('.switch/agents/a.json', 'token', { secret: true });

    expect(await readFile(path.join(dir, 'a.json'), 'utf8')).toBe('token');
    expect(await modeOf(path.join(dir, 'a.json'))).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o755);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another account'), { dir });
  });

  it('still fails when the directory cannot be changed for any other reason', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    refuseChmod(dir, 'EROFS');

    await expect(
      createPluginFs(root).write('.switch/agents/a.json', 'token', { secret: true })
    ).rejects.toThrow(/EROFS/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('protects only the file when asked to leave its directory alone', async () => {
    const dir = path.join(root, '.claude');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, 'settings.local.json'), '{}', { mode: 0o644 });

    expect(
      await createPluginFs(root).protectSecret('.claude/settings.local.json', { fileOnly: true })
    ).toBe(true);

    expect(await modeOf(path.join(dir, 'settings.local.json'))).toBe(0o600);
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('refuses to protect a path outside its root', async () => {
    await expect(createPluginFs(root).protectSecret('../outside.json')).rejects.toThrow(
      /path escape/
    );
  });
});

describe.skipIf(process.platform === 'win32')('createPluginFs list', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'plugin-fs-list-'));
  });

  afterEach(async () => {
    await chmod(path.join(root, 'locked'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('answers [] for a directory that is not there, strict or not', async () => {
    const fs = createPluginFs(root);
    await writeFile(path.join(root, 'afile'), 'x');
    expect(await fs.list('missing')).toEqual([]);
    expect(await fs.list('missing', { strict: true })).toEqual([]);
    expect(await fs.list('afile', { strict: true })).toEqual([]);
  });

  it('throws for a directory it may not read only when strict', async () => {
    const fs = createPluginFs(root);
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'a.json'), 'token');
    await chmod(path.join(root, 'locked'), 0o000);

    expect(await fs.list('locked')).toEqual([]);
    await expect(fs.list('locked', { strict: true })).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('createPluginFs secret write on Windows', () => {
  const platform = process.platform;
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(tmpdir(), 'plugin-fs-secret-win-'));
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: platform });
    await rm(root, { recursive: true, force: true });
  });

  it('restricts the directory, then the still-empty temporary file, before writing the token', async () => {
    const seen: Array<[string, string, string | null]> = [];
    acl.directory.mockImplementationOnce(async (p) => void seen.push(['directory', p, null]));
    acl.file.mockImplementationOnce(
      async (p) => void seen.push(['file', p, await readFile(p, 'utf8')])
    );

    await createPluginFs(root).write('.switch/agents/a.json', 'token', { secret: true });

    const dir = path.join(root, '.switch', 'agents');
    expect(seen).toEqual([
      ['directory', dir, null],
      ['file', expect.stringMatching(/a\.json\.[0-9a-f-]{36}$/), ''],
    ]);
    expect(await readFile(path.join(dir, 'a.json'), 'utf8')).toBe('token');
  });

  it('protects an existing file and its directory with owner-only ACLs', async () => {
    const dir = path.join(root, '.switch', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'a.json'), 'token');

    expect(await createPluginFs(root).protectSecret('.switch/agents/a.json')).toBe(true);

    expect(acl.directory).toHaveBeenCalledWith(dir);
    expect(acl.file).toHaveBeenCalledWith(path.join(dir, 'a.json'));
  });
});

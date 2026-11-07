import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerBundle } from './bundle';
import { nativeLayout } from './native-paths';
import { resolvePostgres } from './postgres-binaries';
import { hasVcRuntime, isDllNotFound } from './vc-runtime';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const installPinnedArchive = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./download', () => ({ installPinnedArchive }));

describe('hasVcRuntime', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'switch-vcrt-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is never missing off Windows', async () => {
    expect(await hasVcRuntime(null, { SystemRoot: dir }, 'linux')).toBe(true);
  });

  it('is missing on a clean Windows with nothing in System32 or beside the binaries', async () => {
    await mkdir(path.join(dir, 'System32'), { recursive: true });
    expect(await hasVcRuntime(path.join(dir, 'bin'), { SystemRoot: dir }, 'win32')).toBe(false);
  });

  it('is found in System32, where the redistributable installs it', async () => {
    await mkdir(path.join(dir, 'System32'), { recursive: true });
    await writeFile(path.join(dir, 'System32', 'vcruntime140.dll'), '');
    expect(await hasVcRuntime(null, { systemroot: dir }, 'win32')).toBe(true);
  });

  it('is found beside the binaries, which Windows searches first', async () => {
    await mkdir(path.join(dir, 'bin'), { recursive: true });
    await writeFile(path.join(dir, 'bin', 'vcruntime140.dll'), '');
    expect(await hasVcRuntime(path.join(dir, 'bin'), { SystemRoot: dir }, 'win32')).toBe(true);
  });
});

describe('isDllNotFound', () => {
  it('recognises STATUS_DLL_NOT_FOUND in either sign', () => {
    expect(isDllNotFound({ code: 3221225781 })).toBe(true);
    expect(isDllNotFound({ code: -1073741515 })).toBe(true);
    expect(isDllNotFound({ code: 1 })).toBe(false);
    expect(isDllNotFound(new Error('x'))).toBe(false);
  });
});

describe('resolvePostgres on a Windows machine without the VC++ runtime', () => {
  const realPlatform = process.platform;
  const realArch = process.arch;
  const realSystemRoot = process.env.SystemRoot;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'switch-vcrt-pg-'));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env.SystemRoot = path.join(root, 'Windows');
    await mkdir(path.join(root, 'Windows', 'System32'), { recursive: true });
    installPinnedArchive.mockClear();
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    Object.defineProperty(process, 'arch', { value: realArch });
    if (realSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = realSystemRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('says the redistributable is missing, rather than that PostgreSQL does not run', async () => {
    // A bundled portable PostgreSQL that cannot load: its binaries are there,
    // but on this machine they fail to start.
    const binDir = path.join(root, 'bundle', 'postgres', 'bin');
    await mkdir(binDir, { recursive: true });
    for (const name of ['initdb', 'pg_ctl', 'postgres']) {
      await writeFile(path.join(binDir, `${name}.exe`), '');
    }
    const bundle = { postgresBinDir: binDir } as LocalServerBundle;
    const layout = nativeLayout(path.join(root, 'server'));

    const attempt = resolvePostgres(layout, bundle, () => {});
    await expect(attempt).rejects.toThrow('Microsoft Visual C++ Redistributable');
    await expect(attempt).rejects.toThrow('https://aka.ms/vs/17/release/vc_redist.x64.exe');
    // Downloading another copy would fail the same way.
    expect(installPinnedArchive).not.toHaveBeenCalled();
  });

  it('refuses before downloading in a build that ships no PostgreSQL', async () => {
    const layout = nativeLayout(path.join(root, 'server'));
    await expect(resolvePostgres(layout, null, () => {})).rejects.toThrow(
      'Microsoft Visual C++ Redistributable'
    );
    expect(installPinnedArchive).not.toHaveBeenCalled();
  });
});

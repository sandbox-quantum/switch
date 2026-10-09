import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinnedBinary, readCliToolStatuses } from './cli-binaries';
import type { CliTool } from './service-access';

const URL_ = 'https://downloads.example.test/excli-1.2.3-linux-x64.tar.gz';

function tool(targets: CliTool['release']['targets']): CliTool {
  return {
    name: 'example-cli',
    binary: 'excli',
    token_env: 'EXCLI_TOKEN',
    config_env: null,
    allow: ['items'],
    deny: [],
    path_flags: {},
    output_cap_bytes: 65536,
    timeout_s: 60,
    token_refused: { exit_code: 1, json_path: 'error.code', value: 401 },
    release: { version: '1.2.3', targets },
  };
}

describe.skipIf(process.platform === 'win32')('pinnedBinary', () => {
  let root: string;
  let base: string;
  let archive: Buffer;
  let sha256: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-binaries-'));
    base = join(root, 'tools');
    // A release archive as vendors ship them: the binary beside its notes.
    const release = join(root, 'release');
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(join(release, 'bin', 'excli'), '#!/bin/sh\necho excli 1.2.3\n');
    await writeFile(join(release, 'README.md'), 'notes');
    const path = join(root, 'excli.tar.gz');
    await promisify(execFile)('tar', ['-czf', path, '-C', release, '.']);
    archive = await readFile(path);
    sha256 = createHash('sha256').update(archive).digest('hex');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serving = (body: Buffer, status = 200) =>
    vi.fn<typeof fetch>(async () => new Response(new Uint8Array(body), { status }));

  const resolver = (fetchImpl: typeof fetch, arch = 'x64') =>
    pinnedBinary({ base, platform: 'linux', arch, fetch: fetchImpl, tar: 'tar' });

  it('installs the build for this machine once, checked, and runs from it', async () => {
    const fetchImpl = serving(archive);
    const find = resolver(fetchImpl);
    const pinned = tool({ 'linux-x64': { url: URL_, sha256, path: 'bin/excli' } });
    const [first, second] = await Promise.all([find(pinned), find(pinned)]);
    expect(first).toBe(join(base, 'excli', sha256, 'bin', 'excli'));
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(URL_);
    expect((await stat(first)).mode & 0o111).not.toBe(0);
    const { stdout } = await promisify(execFile)(first);
    expect(stdout).toBe('excli 1.2.3\n');
    // A later session finds it installed.
    expect(await resolver(serving(Buffer.alloc(0)))(pinned)).toBe(first);
    expect(await readCliToolStatuses(base)).toEqual([{ tool: 'excli', state: 'ok' }]);
  });

  it('refuses an archive whose SHA-256 is not the pinned one, and keeps nothing', async () => {
    const pinned = tool({ 'linux-x64': { url: URL_, sha256: 'f'.repeat(64), path: 'bin/excli' } });
    await expect(resolver(serving(archive))(pinned)).rejects.toThrow('pinned SHA-256');
    expect(await stat(join(base, 'excli', 'f'.repeat(64))).catch(() => null)).toBeNull();
    expect(await readCliToolStatuses(base)).toEqual([{ tool: 'excli', state: 'missing' }]);
    const status = JSON.parse(await readFile(join(base, 'status.json'), 'utf8'));
    expect(status.excli.detail).toContain('pinned SHA-256');
  });

  it('says so on a machine the release has no build for', async () => {
    const pinned = tool({ 'linux-x64': { url: URL_, sha256, path: 'bin/excli' } });
    const fetchImpl = serving(archive);
    await expect(resolver(fetchImpl, 'arm64')(pinned)).rejects.toThrow(
      'no build for this machine (linux-arm64)'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readCliToolStatuses(base)).toEqual([{ tool: 'excli', state: 'unsupported' }]);
  });

  it('says so when the download fails or the archive lacks the binary', async () => {
    const pinned = tool({ 'linux-x64': { url: URL_, sha256, path: 'bin/excli' } });
    await expect(resolver(serving(Buffer.from('gone'), 404))(pinned)).rejects.toThrow(
      'failed (HTTP 404)'
    );
    const wrongPath = tool({ 'linux-x64': { url: URL_, sha256, path: 'excli' } });
    await expect(resolver(serving(archive))(wrongPath)).rejects.toThrow('has no excli');
  });
});

describe('readCliToolStatuses', () => {
  it('names no tool on a machine where no session has needed one', async () => {
    expect(await readCliToolStatuses(join(tmpdir(), 'no-such-switch-tools'))).toEqual([]);
  });
});

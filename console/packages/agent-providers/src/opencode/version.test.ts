import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOpencodeServer } from './server';
import { checkOpencodeSignIn } from './sign-in';
import {
  assertSupportedOpencode,
  isSupportedOpencodeVersion,
  OPENCODE_UNSUPPORTED_MESSAGE,
  OpencodeUnsupportedVersionError,
  parseOpencodeVersion,
} from './version';

describe('parseOpencodeVersion', () => {
  it('reads the 1.x and 2.x output shapes', () => {
    expect(parseOpencodeVersion('1.19.5\n')).toBe('1.19.5');
    expect(parseOpencodeVersion('opencode v2.2.5\n')).toBe('2.2.5');
    expect(parseOpencodeVersion('no version here')).toBeNull();
  });

  it('supports only the 1.x major', () => {
    expect(isSupportedOpencodeVersion('1.19.5')).toBe(true);
    expect(isSupportedOpencodeVersion('2.0.0')).toBe(false);
    expect(isSupportedOpencodeVersion('2.2.5')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('OpenCode 2.x guard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opencode-version-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A stand-in `opencode` that prints `version` for --version and, for anything
   * else, records that it ran and prints what OpenCode 2.x prints when serving.
   */
  async function fakeOpencode(version: string): Promise<string> {
    const path = join(dir, 'opencode');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
        `touch "${join(dir, 'served')}"`,
        'echo "server listening on http://127.0.0.1:1"',
        'sleep 30',
      ].join('\n')
    );
    await chmod(path, 0o755);
    return path;
  }

  const env = () => ({ PATH: process.env.PATH ?? '', HOME: dir });

  it('lets 1.x through', async () => {
    const binaryPath = await fakeOpencode('1.19.5');
    await expect(assertSupportedOpencode({ binaryPath, cwd: dir, env: env() })).resolves.toBe(
      undefined
    );
  });

  it('refuses to start a 2.x server instead of timing out', async () => {
    const binaryPath = await fakeOpencode('opencode v2.2.5');
    const started = Date.now();
    const error = await startOpencodeServer({
      binaryPath,
      cwd: dir,
      env: env(),
      config: { $schema: 'https://opencode.ai/config.json', permission: {}, mcp: {} },
      startupTimeoutMs: 15000,
      skills: [],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeUnsupportedVersionError);
    expect((error as Error).message).toContain(OPENCODE_UNSUPPORTED_MESSAGE);
    expect((error as Error).message).toContain('2.2.5');
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(access(join(dir, 'served'))).rejects.toThrow();
  });

  it('reports 2.x as unsupported in the sign-in check', async () => {
    const binaryPath = await fakeOpencode('opencode v2.2.5');
    const result = await checkOpencodeSignIn({ binaryPath, cwd: dir, env: env() });
    expect(result).toEqual({
      status: 'unknown',
      message: OPENCODE_UNSUPPORTED_MESSAGE,
      models: [],
      loginHelps: false,
    });
  });
});

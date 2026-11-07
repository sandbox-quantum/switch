import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPiSignIn, parsePiModelList } from './sign-in';

/** `pi --list-models` as Pi 1.4.0 prints it with a Gemini key set. */
const LISTED = `provider  model                  context  max-out  thinking  images
google    gemini-2.5-flash       1.0M     65.5K    yes       yes
google    gemini-2.5-flash-lite  1.0M     65.5K    yes       yes
`;

const NONE = `No models available. Use /login to log into a provider via OAuth or API key. See:
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
`;

describe("Pi's model list", () => {
  it('reads each row as provider/model', () => {
    expect(parsePiModelList(LISTED)).toEqual([
      { id: 'google/gemini-2.5-flash', name: 'gemini-2.5-flash (google)' },
      { id: 'google/gemini-2.5-flash-lite', name: 'gemini-2.5-flash-lite (google)' },
    ]);
  });

  it('is empty when Pi has no models', () => {
    expect(parsePiModelList(NONE)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the sign-in check', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-sign-in-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A `pi` that records how it was run and prints `output`. */
  async function pi(output: string): Promise<string> {
    const binary = join(dir, 'pi');
    await writeFile(join(dir, 'output'), output);
    await writeFile(
      binary,
      `#!/bin/sh\necho "$* PI_OFFLINE=$PI_OFFLINE" > "${dir}/ran"\ncat "${dir}/output"\n`
    );
    await chmod(binary, 0o755);
    return binary;
  }

  it('reads the models Pi has a credential for, offline', async () => {
    const binaryPath = await pi(LISTED);
    const result = await checkPiSignIn({ binaryPath, cwd: dir, env: { PATH: '/usr/bin:/bin' } });
    expect(result).toMatchObject({ status: 'authenticated', message: 'Pi can use 2 models.' });
    expect(result.models.map((model) => model.id)).toEqual([
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
    ]);
    expect((await readFile(join(dir, 'ran'), 'utf8')).trim()).toBe('--list-models PI_OFFLINE=1');
  });

  it('says how to sign in when Pi has no models', async () => {
    const result = await checkPiSignIn({
      binaryPath: await pi(NONE),
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('type /login');
    expect(result).not.toHaveProperty('loginHelps');
  });

  it('cannot tell when Pi does not run', async () => {
    const result = await checkPiSignIn({
      binaryPath: join(dir, 'missing'),
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(result).toMatchObject({ status: 'unknown', loginHelps: false });
  });
});

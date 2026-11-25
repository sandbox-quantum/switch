import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginCommandFor, runSetupCheck } from './setup-checks';

/** A stand-in `claude` that answers `auth status` as signed in, or `loggedIn`. */
async function fakeClaude(loggedIn: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'setup-checks-'));
  const path = join(dir, 'claude');
  await writeFile(path, `#!/bin/sh\necho '{"loggedIn": ${loggedIn}}'\n`);
  await chmod(path, 0o755);
  return path;
}

const where = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } };

describe.skipIf(process.platform === 'win32')('runSetupCheck', () => {
  it("runs the provider's check on the executable named, giving its output", async () => {
    const binaryPath = await fakeClaude(true);
    const result = await runSetupCheck({
      provider: 'claude',
      check: 'auth-status',
      installationConfig: { binaryPath },
      input: {},
      ...where,
    });
    expect(result).toEqual({
      ok: true,
      output: { loggedIn: true, authMethod: null, apiProvider: null },
    });
  });

  it('tells a check that found the executable signed out', async () => {
    const binaryPath = await fakeClaude(false);
    const result = await runSetupCheck({
      provider: 'claude',
      check: 'auth-status',
      installationConfig: { binaryPath },
      input: {},
      ...where,
    });
    expect(result).toMatchObject({ ok: true, output: { loggedIn: false } });
  });

  it('says why where the check fails, rather than throwing', async () => {
    const result = await runSetupCheck({
      provider: 'claude',
      check: 'auth-status',
      installationConfig: { binaryPath: '/bin/echo' },
      input: {},
      ...where,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('too old') });
  });
});

describe('runSetupCheck, where it cannot run', () => {
  it('says so for a check the provider does not have, rather than throwing', async () => {
    const result = await runSetupCheck({
      provider: 'codex',
      check: 'test-prompt',
      installationConfig: { binaryPath: '/bin/codex' },
      input: {},
      ...where,
    });
    expect(result).toEqual({ ok: false, reason: 'The codex runtime has no check test-prompt.' });
  });

  it('says so for a provider it does not know', async () => {
    const result = await runSetupCheck({
      provider: 'nobody',
      check: 'auth-status',
      installationConfig: { binaryPath: '/bin/x' },
      input: {},
      ...where,
    });
    expect(result.ok).toBe(false);
  });
});

describe('loginCommandFor', () => {
  it("gives the provider's login command", () => {
    expect(loginCommandFor('claude', { binaryPath: '/bin/claude' })).toBe('claude auth login');
  });
});

/** A stand-in `codex` whose `login status` says it is signed in, or not, as a real one does. */
async function fakeCodex(loggedIn: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'setup-checks-'));
  const path = join(dir, 'codex');
  await writeFile(
    path,
    loggedIn
      ? `#!/bin/sh\necho 'Logged in using ChatGPT'\n`
      : `#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n`
  );
  await chmod(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')("Codex's login-status check", () => {
  it.each([
    [true, 'Logged in using ChatGPT'],
    [false, 'Not logged in'],
  ])('reads whether it is signed in (%s) and what it says', async (loggedIn, message) => {
    const result = await runSetupCheck({
      provider: 'codex',
      check: 'login-status',
      installationConfig: { binaryPath: await fakeCodex(loggedIn) },
      input: {},
      ...where,
    });
    expect(result).toEqual({ ok: true, output: { loggedIn, message } });
  });

  it('fails where there is no Codex to ask', async () => {
    const result = await runSetupCheck({
      provider: 'codex',
      check: 'login-status',
      installationConfig: { binaryPath: '/nowhere/codex' },
      input: {},
      ...where,
    });
    expect(result.ok).toBe(false);
  });
});

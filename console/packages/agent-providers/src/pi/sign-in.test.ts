import { beforeEach, describe, expect, it, vi } from 'vitest';

let stdout = '';
const calls: Array<{ args: string[]; env: Record<string, string> }> = [];

vi.mock('../provider-process', () => ({
  execProvider: async (
    _command: string,
    args: string[],
    options: { env: Record<string, string> }
  ) => {
    calls.push({ args, env: options.env });
    return { stdout, stderr: '' };
  },
}));

const { checkPiSignIn } = await import('./sign-in');
const { PI_SIGN_IN_REQUIRED } = await import('./pi-adapter');

const input = { binaryPath: 'pi', cwd: '/home/me', env: { PATH: '/usr/bin' } };

describe('checkPiSignIn', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('is signed in when pi lists a model it holds a credential for', async () => {
    stdout = [
      'provider  model             context  max-out  thinking  images',
      'google    gemini-2.5-flash  1.0M     65.5K    yes       yes',
      '',
    ].join('\n');
    expect((await checkPiSignIn(input)).status).toBe('authenticated');
  });

  it('is signed out, saying how to sign in, when pi lists none', async () => {
    stdout =
      'No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n';
    expect(await checkPiSignIn(input)).toEqual({
      status: 'unauthenticated',
      message: PI_SIGN_IN_REQUIRED,
      models: [],
    });
  });

  it('asks offline, so the check neither refreshes a catalog nor signs in', async () => {
    stdout = '';
    await checkPiSignIn(input);
    expect(calls).toEqual([
      { args: ['--list-models'], env: { PATH: '/usr/bin', PI_OFFLINE: '1' } },
    ]);
  });
});

import { expect, it } from 'vitest';
import { junieAcp } from './junie-adapter';

const signedOut = { authMethods: [{ id: 'jetbrains-account', name: 'Junie Account' }] };

function check(env: Record<string, string>, handshake: () => Promise<unknown>) {
  return junieAcp.checkSignIn!({
    binaryPath: 'junie',
    cwd: '/work',
    env,
    handshake: handshake as never,
  });
}

it('starts the agent in ACP mode with the environment it was given', async () => {
  const launch = await junieAcp.launch({ binaryPath: '/bin/junie', env: { HOME: '/h' } } as never);
  expect(launch).toEqual({ command: '/bin/junie', args: ['--acp=true'], env: { HOME: '/h' } });
});

it('reads JUNIE_API_KEY as signed in without starting the agent', async () => {
  const result = await check({ JUNIE_API_KEY: 'jb_synthetic' }, () => {
    throw new Error('should not run');
  });
  expect(result.status).toBe('authenticated');
});

it('does not claim signed out from the sign-in method the agent always lists', async () => {
  const result = await check({}, async () => signedOut);
  expect(result.status).toBe('unknown');
  expect(result.message).toContain('junie');
});

it('signs in with the account only when it was given no key', () => {
  expect(junieAcp.authMethodId?.({})).toBe('jetbrains-account');
  expect(junieAcp.authMethodId?.({ JUNIE_API_KEY: 'jb_synthetic' })).toBeUndefined();
});

it('reports signed in when the agent wants no sign-in', async () => {
  expect((await check({}, async () => ({}))).status).toBe('authenticated');
});

it('turns a sign-in error from the agent into signed out and rethrows others', async () => {
  const rejects = (message: string) => async () => {
    throw new Error(message);
  };
  expect(
    (await check({}, rejects('Authentication is required before this operation'))).status
  ).toBe('unauthenticated');
  await expect(check({}, rejects('spawn ENOENT'))).rejects.toThrow('ENOENT');
});

it('passes JUNIE_API_KEY through to the session host', () => {
  expect(junieAcp.inheritEnv).toContain('JUNIE_API_KEY');
});

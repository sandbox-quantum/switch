import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export const CODEX_LOGIN = 'codex login';

export const CODEX_KEYRING_LOGIN_UNUSABLE =
  "Codex's login is in the OS keyring, and Switch sessions can use a keyring login only when it " +
  'is an API key. Unless your organization enforces the keyring, set cli_auth_credentials_store ' +
  '= "file" in the Codex config.toml, which keeps the login in plaintext, then run codex login again.';

export async function checkCodexSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const client = new StdioJsonRpcClient({
    command: input.binaryPath,
    args: ['app-server'],
    cwd: input.cwd,
    env: input.env,
    logger: noopLogger,
    onExit: () => {},
  });
  const timer = setTimeout(() => {
    void client.dispose().catch(() => console.warn('Provider readiness process cleanup failed.'));
  }, 20000);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'switch-console', version: '0.1.0' },
    });
    client.notify('initialized', null);
    const account = z
      .object({
        account: z.object({ type: z.string() }).nullable(),
        requiresOpenaiAuth: z.boolean(),
      })
      .parse(await client.request('account/read', { refreshToken: false }));
    if (!account.account && account.requiresOpenaiAuth)
      return readiness('unauthenticated', signInWith(CODEX_LOGIN));
    if (!account.account)
      return readiness('unknown', 'This Codex backend does not require OpenAI sign-in.');
    if (
      account.requiresOpenaiAuth &&
      account.account.type !== 'apiKey' &&
      !(await hasAuthFile(input.env))
    )
      return readiness('unauthenticated', CODEX_KEYRING_LOGIN_UNUSABLE);
    return readiness('authenticated', 'Signed in.');
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}

/**
 * Whether the Codex home a session copies its login from has an auth.json.
 * Without one the login Codex reports is in the OS keyring, which a session's
 * own Codex home cannot reach; only an API key is handed over from there.
 * Sessions resolve the home the same way (`prepareSharedConfig`).
 */
async function hasAuthFile(env: Record<string, string>): Promise<boolean> {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  try {
    return (await stat(join(home, 'auth.json'))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

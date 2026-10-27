import { z } from 'zod';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { codexSourceHome, hasCodexAuthFile } from './home';
import { CODEX_EPHEMERAL_LOGIN_ARGS, readCodexCredentialStore } from './keyring-login';

export const CODEX_LOGIN = 'codex login';

const METHOD_NOT_FOUND = -32601;

const FILE_STORE_WORKAROUND =
  'Unless your organization enforces the keyring, set cli_auth_credentials_store = "file" in its ' +
  'config.toml (it then keeps the login in plaintext) and run codex login again.';

export const codexKeyringLoginUnusable = (home: string) =>
  `Codex keeps the login for ${home} in the OS keyring, where sessions can use only an OpenAI API key. ${FILE_STORE_WORKAROUND}`;

export const codexKeyringIgnoresAuthFile = (home: string) =>
  `Codex is set to use the OS keyring for ${home}, so sessions ignore the auth.json there. ${FILE_STORE_WORKAROUND}`;

export const codexKeyringApiKeyPinned = (home: string) =>
  `Codex keeps an API key for ${home} in the OS keyring, but an administrator's Codex configuration decides where logins are kept, so Switch cannot hand the key to sessions without Codex saving a copy of it.`;

const accountSchema = z.object({
  account: z
    .object({ type: z.string().optional(), usesCodexManagedCredentials: z.boolean().optional() })
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

export async function checkCodexSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  return withAppServer(input, [], async (client) => {
    const { account, requiresOpenaiAuth } = accountSchema.parse(
      await client.request('account/read', { refreshToken: false })
    );
    if (!account && requiresOpenaiAuth)
      return readiness('unauthenticated', signInWith(CODEX_LOGIN));
    if (!account)
      return readiness('unknown', 'This Codex backend does not require OpenAI sign-in.');
    // Bedrock on AWS's own credentials keeps nothing in Codex's login store.
    if (account.type === 'amazonBedrock' && !account.usesCodexManagedCredentials)
      return readiness('authenticated', 'Signed in.');
    return sessionLogin(input, client, account.type === 'apiKey');
  });
}

/**
 * Whether sessions can use the login Codex reports. A session copies only
 * auth.json from the Codex home, and its Codex ignores that file when set to
 * use the keyring. Without the file, only an API key is handed over from the
 * keyring, and only when Codex lets the session keep it in memory
 * (`CodexAdapter.signInFromKeyring`).
 */
async function sessionLogin(
  input: SignInCheckInput,
  client: StdioJsonRpcClient,
  apiKey: boolean
): Promise<ProviderReadiness> {
  // Relative to where the Codex that answered runs, so both look at one home.
  const home = codexSourceHome(input.env, input.cwd);
  let inFile: boolean;
  try {
    inFile = await hasCodexAuthFile(home);
  } catch (error) {
    return readiness(
      'unknown',
      `Could not check for Codex's auth.json in ${home}: ${String((error as Error).cause ?? error)}`
    );
  }
  if (inFile)
    return (await fileStoreSetting(client, input.cwd)) === 'keyring'
      ? readiness('unauthenticated', codexKeyringIgnoresAuthFile(home))
      : readiness('authenticated', 'Signed in.');
  if (!apiKey) return readiness('unauthenticated', codexKeyringLoginUnusable(home));
  const sessionStore = await withAppServer(input, CODEX_EPHEMERAL_LOGIN_ARGS, (session) =>
    readCodexCredentialStore(session, input.cwd)
  );
  return sessionStore === 'ephemeral'
    ? readiness('authenticated', 'Signed in.')
    : readiness('unauthenticated', codexKeyringApiKeyPinned(home));
}

/** Where Codex keeps logins, or null from a Codex too old to say, which is taken as a file. */
async function fileStoreSetting(client: StdioJsonRpcClient, cwd: string): Promise<unknown> {
  try {
    return await readCodexCredentialStore(client, cwd);
  } catch (error) {
    if (error instanceof JsonRpcError && error.code === METHOD_NOT_FOUND) return null;
    throw error;
  }
}

async function withAppServer<T>(
  input: SignInCheckInput,
  args: string[],
  read: (client: StdioJsonRpcClient) => Promise<T>
): Promise<T> {
  const client = new StdioJsonRpcClient({
    command: input.binaryPath,
    args: ['app-server', ...args],
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
    return await read(client);
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}

import { z } from 'zod';
import {
  loginWontHelp,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { codexSourceHome, hasCodexAuthFile } from './home';
import {
  CODEX_EPHEMERAL_LOGIN_ARGS,
  codexAuthStatusSchema,
  isUnknownCodexMethod,
  readCodexCredentialStore,
} from './keyring-login';

export const CODEX_LOGIN = 'codex login';

/** How long the whole check may take, across every Codex it starts. */
const CHECK_TIMEOUT_MS = 20_000;

/**
 * Shorter than `CODEX_FILE_STORE_WORKAROUND`: the controller keeps only 300
 * characters of what a check says, so the instruction comes before the home.
 */
const FILE_STORE_WORKAROUND =
  'Unless your organization enforces the keyring, set cli_auth_credentials_store = "file" in its ' +
  'config.toml (it then keeps the login in plaintext) and run codex login again.';

const inHome = (home: string) => `(Codex home: ${home})`;

export const codexKeyringLoginUnusable = (home: string) =>
  `Codex keeps this login in the OS keyring, where sessions can use only an OpenAI API key. ${FILE_STORE_WORKAROUND} ${inHome(home)}`;

export const codexKeyringIgnoresAuthFile = (home: string) =>
  `Codex is set to use the OS keyring, so sessions ignore its auth.json. ${FILE_STORE_WORKAROUND} ${inHome(home)}`;

export const codexKeyringApiKeyWithheld = (home: string) =>
  `Codex keeps this API key in the OS keyring, but this version of Codex will not hand it to Switch. ${FILE_STORE_WORKAROUND} ${inHome(home)}`;

export const codexKeyringStorePinned = (home: string, store: unknown) =>
  `Codex keeps this API key in the OS keyring, but sets cli_auth_credentials_store to ${JSON.stringify(store ?? null)} for a session where Switch asks for "ephemeral" (an administrator's managed configuration can do this), so Switch cannot hand the key over. ${inHome(home)}`;

export const codexSessionLoginUnchecked = (home: string, cause: string) =>
  `Codex is signed in, but whether sessions can use its login could not be checked: ${cause} ${inHome(home)}`;

const accountSchema = z.object({
  account: z
    .object({ type: z.string().optional(), usesCodexManagedCredentials: z.boolean().optional() })
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

/** An API key in the keyring, still to be checked against a Codex started as a session's is. */
type HandOver = { handOver: string };

export async function checkCodexSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let sourceHome: string;
  try {
    sourceHome = codexSourceHome(input.env);
  } catch (error) {
    // Sessions refuse it the same way, and no sign-in changes it.
    return loginWontHelp(readiness('unauthenticated', describe(error)));
  }
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  // The home this Codex read the login from, as Codex resolved it, when it says.
  const found = await withAppServer(input, [], deadline, (client, codexHome) =>
    machineLogin(input, client, codexHome ?? sourceHome)
  );
  // Asked only once the first Codex has stopped, within the same deadline.
  return 'handOver' in found ? handOverStore(input, deadline, found.handOver) : found;
}

/**
 * Whether sessions can use the login Codex reports. A session copies only
 * auth.json from the Codex home, and its Codex ignores that file when set to
 * use the keyring. Without the file, only an API key is handed over from the
 * keyring (`readCodexKeyringApiKey`), and only into a session whose Codex
 * keeps it in memory (`CodexAdapter.signInFromKeyring`).
 */
async function machineLogin(
  input: SignInCheckInput,
  client: StdioJsonRpcClient,
  home: string
): Promise<ProviderReadiness | HandOver> {
  const { account, requiresOpenaiAuth } = accountSchema.parse(
    await client.request('account/read', { refreshToken: false })
  );
  if (!account && requiresOpenaiAuth) return readiness('unauthenticated', signInWith(CODEX_LOGIN));
  if (!account) return readiness('unknown', 'This Codex backend does not require OpenAI sign-in.');
  // Bedrock on AWS's own credentials keeps nothing in Codex's login store.
  if (account.type === 'amazonBedrock' && account.usesCodexManagedCredentials === false)
    return readiness('authenticated', 'Signed in.');
  let inFile: boolean;
  try {
    inFile = await hasCodexAuthFile(home);
  } catch (error) {
    return readiness('unknown', codexSessionLoginUnchecked(home, describe(error)));
  }
  if (inFile) {
    let store: unknown;
    try {
      store = await readCodexCredentialStore(client, input.cwd);
    } catch (error) {
      return readiness(
        'unknown',
        codexSessionLoginUnchecked(
          home,
          isUnknownCodexMethod(error)
            ? 'this version of Codex cannot say whether it uses the OS keyring.'
            : describe(error)
        )
      );
    }
    return store === 'keyring'
      ? readiness('unauthenticated', codexKeyringIgnoresAuthFile(home))
      : readiness('authenticated', 'Signed in.');
  }
  if (account.type !== 'apiKey')
    return readiness('unauthenticated', codexKeyringLoginUnusable(home));
  let authMethod: string | null;
  try {
    ({ authMethod } = codexAuthStatusSchema.parse(
      await client.request('getAuthStatus', { includeToken: false, refreshToken: false })
    ));
  } catch (error) {
    return isUnknownCodexMethod(error)
      ? readiness('unauthenticated', codexKeyringApiKeyWithheld(home))
      : readiness('unknown', codexSessionLoginUnchecked(home, describe(error)));
  }
  if (authMethod !== 'apikey')
    return readiness('unauthenticated', codexKeyringApiKeyWithheld(home));
  return { handOver: home };
}

async function handOverStore(
  input: SignInCheckInput,
  deadline: number,
  home: string
): Promise<ProviderReadiness> {
  let store: unknown;
  try {
    store = await withAppServer(input, CODEX_EPHEMERAL_LOGIN_ARGS, deadline, (session) =>
      readCodexCredentialStore(session, input.cwd)
    );
  } catch (error) {
    return readiness('unknown', codexSessionLoginUnchecked(home, describe(error)));
  }
  return store === 'ephemeral'
    ? readiness('authenticated', 'Signed in.')
    : loginWontHelp(readiness('unauthenticated', codexKeyringStorePinned(home, store)));
}

function describe(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

async function withAppServer<T>(
  input: SignInCheckInput,
  args: string[],
  deadline: number,
  read: (client: StdioJsonRpcClient, codexHome: string | null) => Promise<T>
): Promise<T> {
  const client = new StdioJsonRpcClient({
    command: input.binaryPath,
    args: ['app-server', ...args],
    cwd: input.cwd,
    env: input.env,
    logger: noopLogger,
    onExit: () => {},
  });
  const timer = setTimeout(
    () => {
      void client.dispose().catch(() => console.warn('Provider readiness process cleanup failed.'));
    },
    Math.max(0, deadline - Date.now())
  );
  try {
    const { codexHome } = z.object({ codexHome: z.string().optional() }).parse(
      await client.request('initialize', {
        clientInfo: { name: 'switch-console', version: '0.1.0' },
      })
    );
    client.notify('initialized', null);
    return await read(client, codexHome ?? null);
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}

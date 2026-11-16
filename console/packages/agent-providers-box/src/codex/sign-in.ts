import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { optionalText } from '../host/provider-home';
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

/** Less than this left of the deadline, and a second Codex is not started at all. */
const START_BUDGET_MS = 2_000;

/**
 * Shorter than `CODEX_FILE_STORE_WORKAROUND`: the controller keeps only 300
 * characters of what a check says, so the instruction comes before the home.
 */
const FILE_STORE_WORKAROUND =
  'Unless your organization enforces the keyring, set cli_auth_credentials_store = "file" in its ' +
  'config.toml (it then keeps the login in plaintext) and run codex login again.';

/**
 * The home as a message names it: from `~` when it is under the user's own
 * home directory, so a reason relayed to agents and rooms does not carry the
 * user's name.
 */
function shown(home: string): string {
  const user = homedir();
  return home === user || home.startsWith(user + sep) ? `~${home.slice(user.length)}` : home;
}

const inHome = (home: string) => `(Codex home: ${shown(home)})`;

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

const BEDROCK_UNSAID =
  'Codex did not say whether this Amazon Bedrock login runs on AWS credentials or on a key Codex keeps, so whether sessions can use it is not known.';

const KIND_UNSAID =
  'Codex did not say what kind of login this is, so whether sessions can use it is not known.';

/** A Codex the check's deadline stopped before it answered. */
class CheckTimeout extends Error {
  constructor() {
    super(`the check ran out of its ${CHECK_TIMEOUT_MS / 1000} seconds.`);
  }
}

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
  let found: ProviderReadiness | HandOver;
  try {
    // The home this Codex read the login from, as Codex resolved it, when it says.
    found = await withAppServer(input, [], deadline, (client, codexHome) =>
      machineLogin(input, client, codexHome ?? sourceHome, deadline)
    );
  } catch (error) {
    if (error instanceof CheckTimeout)
      return loginWontHelp(
        readiness('unknown', `Could not check Codex's sign-in: ${error.message}`)
      );
    throw error;
  }
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
  home: string,
  deadline: number
): Promise<ProviderReadiness | HandOver> {
  const { account, requiresOpenaiAuth } = accountSchema.parse(
    await client.request('account/read', { refreshToken: false })
  );
  if (!account && requiresOpenaiAuth) return readiness('unauthenticated', signInWith(CODEX_LOGIN));
  if (!account) return readiness('unknown', 'This Codex backend does not require OpenAI sign-in.');
  // Bedrock on AWS's own credentials keeps nothing in Codex's login store.
  if (account.type === 'amazonBedrock' && account.usesCodexManagedCredentials === false)
    return readiness('authenticated', 'Signed in.');
  // Sessions on a backend that needs no OpenAI login never use one, so a
  // leftover login does not matter; Bedrock's key in Codex's store does.
  if (!requiresOpenaiAuth && account.type !== 'amazonBedrock')
    return readiness('authenticated', 'Signed in.');
  let inFile: boolean;
  try {
    inFile = await hasCodexAuthFile(home);
  } catch (error) {
    return unchecked(home, failure(error, deadline));
  }
  if (inFile) {
    let store: unknown;
    try {
      store = await credentialStore(client, input.cwd, home);
    } catch (error) {
      return unchecked(home, failure(error, deadline));
    }
    return store === 'keyring'
      ? readiness('unauthenticated', codexKeyringIgnoresAuthFile(home))
      : readiness('authenticated', 'Signed in.');
  }
  if (account.type === undefined)
    return loginWontHelp(readiness('unknown', `${KIND_UNSAID} ${inHome(home)}`));
  if (account.type === 'amazonBedrock' && account.usesCodexManagedCredentials === undefined)
    return loginWontHelp(readiness('unknown', `${BEDROCK_UNSAID} ${inHome(home)}`));
  if (account.type !== 'apiKey')
    return readiness('unauthenticated', codexKeyringLoginUnusable(home));
  let authMethod: string | null;
  try {
    ({ authMethod } = codexAuthStatusSchema.parse(
      await client.request('getAuthStatus', { includeToken: false, refreshToken: false })
    ));
  } catch (error) {
    return isUnknownCodexMethod(error, 'getAuthStatus')
      ? readiness('unauthenticated', codexKeyringApiKeyWithheld(home))
      : unchecked(home, failure(error, deadline));
  }
  if (authMethod !== 'apikey')
    return readiness('unauthenticated', codexKeyringApiKeyWithheld(home));
  return { handOver: home };
}

/** A check that could not finish: no sign-in changes that, so it is not offered. */
function unchecked(home: string, cause: string): ProviderReadiness {
  return loginWontHelp(readiness('unknown', codexSessionLoginUnchecked(home, cause)));
}

/** Why a request failed: a Codex the deadline stopped fails as an exit, so say what stopped it. */
function failure(error: unknown, deadline: number): string {
  return Date.now() >= deadline ? new CheckTimeout().message : describe(error);
}

/**
 * Where Codex keeps logins for `cwd`. A Codex too old to answer config/read
 * is read from the home's own config.toml instead, which a session inherits;
 * an administrator's managed configuration is then not seen.
 */
async function credentialStore(
  client: StdioJsonRpcClient,
  cwd: string,
  home: string
): Promise<unknown> {
  try {
    return await readCodexCredentialStore(client, cwd);
  } catch (error) {
    if (!isUnknownCodexMethod(error, 'config/read')) throw error;
  }
  const text = await optionalText(join(home, 'config.toml'));
  return text === null ? null : parse(text).cli_auth_credentials_store;
}

async function handOverStore(
  input: SignInCheckInput,
  deadline: number,
  home: string
): Promise<ProviderReadiness> {
  if (deadline - Date.now() < START_BUDGET_MS) return unchecked(home, new CheckTimeout().message);
  let store: unknown;
  try {
    store = await withAppServer(input, CODEX_EPHEMERAL_LOGIN_ARGS, deadline, (session) =>
      readCodexCredentialStore(session, input.cwd)
    );
  } catch (error) {
    // The session asks the same, so a Codex that cannot answer fails it too.
    if (isUnknownCodexMethod(error, 'config/read'))
      return readiness('unauthenticated', codexKeyringApiKeyWithheld(home));
    return unchecked(home, describe(error));
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
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      void client.dispose().catch(() => console.warn('Provider readiness process cleanup failed.'));
    },
    Math.max(0, deadline - Date.now())
  );
  try {
    const { codexHome } = z.object({ codexHome: z.string().nullish() }).parse(
      await client.request('initialize', {
        clientInfo: { name: 'switch-console', version: '0.1.0' },
      })
    );
    client.notify('initialized', null);
    return await read(client, codexHome ?? null);
  } catch (error) {
    // Stopped by the deadline, it fails as an exit; say what stopped it.
    if (timedOut) throw new CheckTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
    // What was read, or went wrong, is the answer: a Codex that will not stop
    // is reported, not put in its place.
    await client
      .dispose()
      .catch((error: unknown) =>
        console.warn(
          `The Codex that checked a sign-in did not stop: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }
}

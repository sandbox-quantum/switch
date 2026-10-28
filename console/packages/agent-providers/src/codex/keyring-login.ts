import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { CodexKeyringLogin } from '../adapter';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

/**
 * Long enough for someone at the machine to answer a keychain prompt, short
 * enough that a prompt nobody sees fails the session with a reason.
 */
export const CODEX_KEYRING_READ_TIMEOUT_MS = 30_000;

const METHOD_NOT_FOUND = -32601;

export const CODEX_FILE_STORE_WORKAROUND =
  'Unless your organization enforces the keyring, set cli_auth_credentials_store = "file" in the ' +
  'Codex config.toml on the execution machine, which keeps the login in plaintext, then run codex ' +
  'login again and start a new session.';

const accountSchema = z.object({
  account: z.object({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});

const authStatusSchema = z.object({
  authMethod: z.string().nullable(),
  authToken: z.string().nullish(),
});

/** A refusal worded here, passed on as it is. */
class KeyringLoginError extends Error {}

function loginKind(type: string): string {
  return type === 'chatgpt' ? 'ChatGPT' : `a ${type} login`;
}

/**
 * The API key the execution machine's Codex keeps in the OS keyring, for a
 * session whose own Codex home has no login to copy. Codex keys a keyring
 * entry by its home's path, so the session's Codex cannot find it; Codex run
 * against its own home reads it instead, and the keychain answers the program
 * that stored the entry without asking anyone.
 *
 * Only an API key is handed over. A ChatGPT login cannot be: Codex exports its
 * access token alone, which expires and cannot be refreshed without the
 * refresh token it keeps. The account is read before the key is asked for
 * because asking refreshes a stale ChatGPT login and writes it back to the
 * user's keyring, racing their own Codex.
 *
 * Null when the machine's Codex is signed out.
 */
export async function readCodexKeyringApiKey(
  binaryPath: string,
  login: CodexKeyringLogin,
  timeoutMs: number
): Promise<string | null> {
  try {
    await stat(login.home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Could not load the execution-host Codex login.', { cause: error });
  }
  // Run in the home rather than the agent's directory, so no project
  // configuration changes where this Codex reads its login.
  const client = new StdioJsonRpcClient({
    command: binaryPath,
    args: ['app-server'],
    cwd: login.home,
    env: { ...login.env, CODEX_HOME: login.home },
    logger: noopLogger,
    onExit: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new KeyringLoginError(
            `Codex on the execution machine did not read its login from the OS keyring within ${timeoutMs / 1000} seconds. The keychain may be locked, or the system may be waiting for someone at that machine to let Codex use its "Codex Auth" keychain item; start the session again once it can.`
          )
        ),
      timeoutMs
    );
  });
  try {
    return await Promise.race([readApiKey(client), timeout]);
  } catch (error) {
    if (error instanceof KeyringLoginError) throw error;
    const output = client.stderr.trim();
    throw new Error(
      `Codex on the execution machine could not report its login: ${error instanceof Error ? error.message : String(error)}${output ? `\n${output}` : ''}`,
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
    // Whatever was read, or went wrong, is the answer: a reader that will not
    // stop is reported, not put in its place.
    await client
      .dispose()
      .catch((error: unknown) =>
        console.warn(
          `The Codex that read a keyring login did not stop: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }
}

async function readApiKey(client: StdioJsonRpcClient): Promise<string | null> {
  await client.request('initialize', { clientInfo: { name: 'switch-console', version: '0.1.0' } });
  client.notify('initialized', null);
  const { account } = accountSchema.parse(
    await client.request('account/read', { refreshToken: false })
  );
  if (!account) return null;
  if (account.type !== 'apiKey')
    throw new KeyringLoginError(
      `Codex on the execution machine is signed in with ${loginKind(account.type)} and has no auth.json, so its login is likely in the OS keyring (cli_auth_credentials_store = "keyring" or "auto"). A Switch session can take a login from the keyring only when it is an API key. ${CODEX_FILE_STORE_WORKAROUND}`
    );
  let status: z.infer<typeof authStatusSchema>;
  try {
    status = authStatusSchema.parse(
      await client.request('getAuthStatus', { includeToken: true, refreshToken: false })
    );
  } catch (error) {
    if (error instanceof JsonRpcError && error.code === METHOD_NOT_FOUND)
      throw new KeyringLoginError(
        `This version of Codex cannot hand Switch the API key it keeps in the OS keyring: it no longer answers getAuthStatus. ${CODEX_FILE_STORE_WORKAROUND}`,
        { cause: error }
      );
    throw error;
  }
  if (status.authMethod !== 'apikey' || !status.authToken)
    throw new KeyringLoginError(
      `Codex on the execution machine reported an API-key login but did not hand over the key. ${CODEX_FILE_STORE_WORKAROUND}`
    );
  return status.authToken;
}

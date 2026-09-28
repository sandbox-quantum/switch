import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_TOKEN_BYTES = 16 * 1024;

function validToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_BYTES && /^[\x21-\x7e]+$/.test(token);
}

export async function readGitHubCredential(path: string): Promise<string> {
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (!validToken(token)) throw new Error();
    return token;
  } catch {
    throw new Error('GitHub credential file is missing or invalid.');
  }
}

/** Personal tokens only. This validates identity, not access to a particular repository. */
export async function validateGitHubCredential(token: string): Promise<void> {
  if (!validToken(token)) throw new Error('GitHub credential is invalid.');
  let response: Response;
  try {
    response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('GitHub credential validation could not reach GitHub; retry when connected.');
  }
  // Never include the remote body or a transport exception in diagnostics.
  try {
    await response.body?.cancel();
  } catch {
    throw new Error('GitHub credential validation failed while closing the response.');
  }
  if (response.status === 401)
    throw new Error(
      'GitHub rejected the credential; replace the expired or revoked personal token.'
    );
  if (response.status === 403)
    throw new Error(
      'GitHub denied the credential check; check token permissions, organization policy or rate limits.'
    );
  if (response.status !== 200)
    throw new Error(
      'GitHub credential validation failed; retry or review the supplied personal token.'
    );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Non-secret command configuration; only GH_TOKEN is supplied separately at launch. */
export function githubLaunchEnvironment(
  entrypoint = fileURLToPath(new URL('./hosted-bootstrap.mjs', import.meta.url))
): Record<string, string> {
  return {
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    // Clear inherited credential stores before selecting this non-persistent helper.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${shellQuote(process.execPath)} ${shellQuote(entrypoint)} --git-credential`,
    GIT_CONFIG_KEY_2: 'core.askPass',
    GIT_CONFIG_VALUE_2: '',
  };
}

export function githubRedactions(token: string): string[] {
  return [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`).toString('base64'),
  ];
}

/** Git credential protocol: no cache/store, no browser, only HTTPS github.com. */
export function gitHubCredentialResponse(operation: string, input: string, token?: string): string {
  if (operation !== 'get') return '';
  if (!token || !validToken(token) || Buffer.byteLength(input) > 64 * 1024) return '';
  const fields = new Map<string, string>();
  for (const line of input.split('\n')) {
    if (line === '') break;
    const at = line.indexOf('=');
    if (at <= 0 || line.includes('\r') || line.includes('\0')) return '';
    const key = line.slice(0, at);
    // Git's array-valued extensions can repeat; only scalar protocol/host
    // fields determine where this helper supplies credentials.
    if (key.endsWith('[]')) continue;
    if (fields.has(key)) return '';
    fields.set(key, line.slice(at + 1));
  }
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') return '';
  return `username=x-access-token\npassword=${token}\n\n`;
}

export async function runGitHubCredentialHelper(operation: string | undefined): Promise<void> {
  if (!operation || !['get', 'store', 'erase'].includes(operation))
    throw new Error('Unsupported Git credential operation.');
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 64 * 1024)
      throw new Error('Git credential request is too large.');
  }
  process.stdout.write(gitHubCredentialResponse(operation, input, process.env.GH_TOKEN));
}

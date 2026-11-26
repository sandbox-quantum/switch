import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AGY_LOGIN, isLegacyAntigravityRuntime } from '../antigravity/runtime';
import { refreshCodexAuthentication } from '../codex/home';
import {
  parseVertexLogin,
  signsInThroughVertex,
  VERTEX_CREDENTIALS_FILE,
  VERTEX_PROVIDERS_ONLY,
  VERTEX_VARIABLES,
  vertexEnvironment,
} from '../vertex-login';
import { ensureLoginDirectory } from './login-directory';
import { importOpenCodeConsole, OPENCODE_CONSOLE_MARKER } from './opencode-console';
import type { HostedCredential } from './provider-login';
import { replaceFile } from './replace-file';

export type { HostedCredential } from './provider-login';

/**
 * Sets the variables `credential` signs in with in `env`, removing the others
 * a provider could sign in with. For a `vertex` login, `root` is where its
 * Google credential is written (`materializeHostedProvider`).
 */
export function applyHostedProvider(
  env: Record<string, string>,
  credential: HostedCredential,
  root: string
): void {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CURSOR_API_KEY',
  ])
    delete env[key];
  if (credential.status === 'revoked')
    throw new Error(
      'The provider was disconnected. Reconnect it in Console before resuming this session.'
    );
  if (signsInThroughVertex(credential.provider))
    for (const key of VERTEX_VARIABLES[credential.provider]) delete env[key];
  if (credential.kind === 'vertex') {
    if (!signsInThroughVertex(credential.provider)) throw new Error(VERTEX_PROVIDERS_ONLY);
    if (credential.provider === 'antigravity') delete env.GEMINI_API_KEY;
    Object.assign(
      env,
      vertexEnvironment(
        credential.provider,
        parseVertexLogin(credential.credential),
        join(root, VERTEX_CREDENTIALS_FILE)
      )
    );
    return;
  }
  if (credential.kind === 'auth-json') return;
  if (!/^[\x21-\x7e]+$/.test(credential.credential))
    throw new Error('Provider credential format is invalid.');
  const variable =
    credential.provider === 'claude'
      ? credential.kind === 'api-key'
        ? 'ANTHROPIC_API_KEY'
        : 'CLAUDE_CODE_OAUTH_TOKEN'
      : credential.provider === 'codex'
        ? 'OPENAI_API_KEY'
        : credential.provider === 'cursor'
          ? 'CURSOR_API_KEY'
          : null;
  if (!variable) throw new Error('This provider requires its native authentication file.');
  env[variable] = credential.credential;
}

async function writeAuthentication(root: string, relative: string, content: string): Promise<void> {
  let directory = root;
  for (const part of ['.', ...relative.split('/').slice(0, -1)]) {
    directory = join(directory, part);
    await ensureLoginDirectory(directory);
  }
  const path = join(root, relative);
  const fingerprint = createHash('sha256').update(content).digest('hex');
  const marker = path + '.switch-credential';
  try {
    if ((await readFile(marker, 'utf8')) === fingerprint && (await lstat(path)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path + '.switch-new';
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await replaceFile(temporary, path);
  const record = await open(
    marker,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await record.writeFile(fingerprint);
    await record.sync();
  } finally {
    await record.close();
  }
}

export async function materializeHostedProvider(
  root: string,
  env: Record<string, string>,
  credential: HostedCredential,
  binaryPath: string
): Promise<void> {
  applyHostedProvider(env, credential, root);
  if (credential.status !== 'connected') return;
  if (credential.kind === 'vertex') {
    // The retired Antigravity ACP runtime signs in only through its own profile.
    if (credential.provider === 'antigravity' && isLegacyAntigravityRuntime(binaryPath))
      throw new Error(
        "Antigravity signs in through Vertex AI only with Google's agy CLI. Install it on the execution machine and select it in provider setup."
      );
    await writeAuthentication(
      root,
      VERTEX_CREDENTIALS_FILE,
      JSON.stringify(parseVertexLogin(credential.credential).credentials)
    );
    return;
  }
  if (credential.kind === 'auth-json') {
    try {
      const value = JSON.parse(credential.credential);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch {
      throw new Error('Provider authentication file is not a JSON object.');
    }
  }
  if (credential.provider === 'codex') {
    const sourceHome = join(root, 'provider-home');
    env.CODEX_HOME ||= sourceHome;
    const content =
      credential.kind === 'api-key'
        ? JSON.stringify({ OPENAI_API_KEY: credential.credential })
        : credential.credential;
    await writeAuthentication(sourceHome, 'auth.json', content);
    if (env.CODEX_HOME !== sourceHome) await refreshCodexAuthentication(env.CODEX_HOME, sourceHome);
  } else if (credential.provider === 'opencode') {
    env.XDG_DATA_HOME = join(root, 'provider-data');
    if (JSON.parse(credential.credential).format === 'switch-opencode-console-v1') {
      await importOpenCodeConsole(env.XDG_DATA_HOME, env, binaryPath, credential.credential);
    } else {
      await writeAuthentication(env.XDG_DATA_HOME, 'opencode/auth.json', credential.credential);
    }
  } else if (credential.provider === 'antigravity') {
    // The login Switch holds is the token file of the runtime Switch Console
    // used to install. Google's agy keeps its sign-in in the system keychain
    // and never reads that file, so handing it the token would leave the
    // session signed out, or signed in as whoever the machine already has.
    if (!isLegacyAntigravityRuntime(binaryPath))
      throw new Error(
        `This agent's Antigravity sign-in was made for Antigravity ACP (antigravity-acp), which Google's agy CLI cannot use. Sign in on the execution machine with ${AGY_LOGIN}, or set GEMINI_API_KEY there, and disconnect the Antigravity login Switch holds for the agent.`
      );
    env.GEMINI_HOME = join(root, 'provider-home');
    await writeAuthentication(
      env.GEMINI_HOME,
      'antigravity-acp/acp_token.json',
      credential.credential
    );
  }
}

const CODEX_LOGIN_FILE = 'provider-home/auth.json';

/** The login files `materializeHostedProvider` writes under its root, whichever provider. */
const HOSTED_LOGIN_FILES = [
  CODEX_LOGIN_FILE,
  VERTEX_CREDENTIALS_FILE,
  'provider-data/opencode/auth.json',
  'provider-home/antigravity-acp/acp_token.json',
];

/**
 * Where an OpenCode console login is imported: OpenCode's own database, which
 * also holds the agent's OpenCode sessions. Removed only when Switch imported a
 * login into it, and then whole, as no other user than the agent can open it.
 */
const OPENCODE_CONSOLE_DIRECTORY = 'provider-data/opencode';
const OPENCODE_CONSOLE_FILES = ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'];

/**
 * Removes every login file `materializeHostedProvider` may have written under
 * `root`, with its marker and any half-written copy: for a login Switch no
 * longer gives the agent, or an agent no longer on this machine. Answers the
 * paths removed. Every file is tried; any that could not be removed are named
 * in the error thrown after.
 */
export async function clearHostedProvider(
  root: string,
  sessionsBase: string | null
): Promise<string[]> {
  const candidates: string[] = [];
  for (const file of HOSTED_LOGIN_FILES)
    candidates.push(
      join(root, file),
      join(root, `${file}.switch-credential`),
      join(root, `${file}.switch-new`)
    );
  const removed: string[] = [];
  const failures: string[] = [];
  // Each Codex session copies the login into a home of its own; only copies
  // of a login Switch wrote, as the agent may run on the machine's own.
  if (sessionsBase !== null && (await exists(join(root, `${CODEX_LOGIN_FILE}.switch-credential`))))
    candidates.push(...(await codexSessionLogins(sessionsBase, failures)));
  const consoleDirectory = join(root, OPENCODE_CONSOLE_DIRECTORY);
  const consoleMarker = join(consoleDirectory, OPENCODE_CONSOLE_MARKER);
  if (await exists(consoleMarker))
    candidates.push(...OPENCODE_CONSOLE_FILES.map((file) => join(consoleDirectory, file)));
  // Markers last: while one is there, a retry knows a login is still behind it.
  const markers = [join(root, `${CODEX_LOGIN_FILE}.switch-credential`), consoleMarker];
  const remove = async (path: string) => {
    try {
      if (!(await exists(path))) return;
      await rm(path, { force: true });
      removed.push(path);
    } catch (error) {
      failures.push(`${path}: ${(error as Error).message}`);
    }
  };
  for (const path of candidates) if (!markers.includes(path)) await remove(path);
  if (!failures.length) for (const marker of markers) await remove(marker);
  if (failures.length)
    throw new Error(`Could not remove the provider login files ${failures.join('; ')}`);
  return removed;
}

/**
 * The login copies in the Codex homes of the agent's sessions under
 * `sessionsBase` (`sharedSessionRoot`, then `prepareCodexSessionHome`):
 * `<session>/provider-home/<home>/auth.json`, never through a link. A folder
 * that cannot be read is added to `failures`.
 */
async function codexSessionLogins(sessionsBase: string, failures: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const session of await directories(sessionsBase, failures)) {
    const homes = join(sessionsBase, session, 'provider-home');
    for (const home of await directories(homes, failures))
      found.push(join(homes, home, 'auth.json'));
  }
  return found;
}

async function directories(path: string, failures: string[]): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      failures.push(`${path}: ${(error as Error).message}`);
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

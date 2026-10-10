import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { refreshCodexAuthentication } from '../codex/home';
import { parseVertexLogin, VERTEX_CREDENTIALS_FILE } from '../vertex-login';
import { importOpenCodeConsole } from './opencode-console';
import type { HostedCredential } from './provider-login';

export type { HostedCredential } from './provider-login';

const VERTEX_VARIABLES = [
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

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
  if (credential.provider === 'claude') for (const key of VERTEX_VARIABLES) delete env[key];
  if (credential.kind === 'vertex') {
    if (credential.provider !== 'claude')
      throw new Error('Only Claude signs in through Vertex AI.');
    const login = parseVertexLogin(credential.credential);
    env.CLAUDE_CODE_USE_VERTEX = '1';
    env.ANTHROPIC_VERTEX_PROJECT_ID = login.project;
    env.CLOUD_ML_REGION = login.region;
    env.GOOGLE_APPLICATION_CREDENTIALS = join(root, VERTEX_CREDENTIALS_FILE);
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error('Provider authentication directory must not be a symbolic link.');
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
  await rename(temporary, path);
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
    env.GEMINI_HOME = join(root, 'provider-home');
    await writeAuthentication(
      env.GEMINI_HOME,
      'antigravity-acp/acp_token.json',
      credential.credential
    );
  }
}

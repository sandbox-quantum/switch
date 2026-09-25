import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { refreshCodexAuthentication } from '../codex/home';
import { importOpenCodeConsole } from './opencode-console';
import { readSharedCredentials, type SharedHostConfig } from './shared-config';

const credentialSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('revoked') }),
  z.object({
    status: z.literal('connected'),
    revision: z.string(),
    provider: z.enum(['claude', 'codex', 'cursor', 'opencode', 'antigravity']),
    kind: z.enum(['api-key', 'setup-token', 'auth-json']),
    credential: z.string().min(1).max(16384),
    sessions: z.array(z.object({ id: z.string(), status: z.string() })),
  }),
]);
export type HostedCredential = z.infer<typeof credentialSchema>;

export async function fetchHostedProvider(config: SharedHostConfig): Promise<HostedCredential> {
  const credentials = await readSharedCredentials(config);
  const url = new URL(credentials.SWITCH_API_ENDPOINT);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Cloud provider access requires HTTPS.');
  let response: Response;
  try {
    response = await fetch(`${url.href.replace(/\/$/, '')}/hosted/provider-credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.SWITCH_API_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Cloud provider access could not be checked.');
  }
  if (response.status === 403) {
    await response.body?.cancel();
    return { status: 'revoked' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloud provider access check failed (HTTP ${response.status}).`);
  }
  const result = credentialSchema.parse(await response.json());
  if (result.status === 'connected' && result.provider !== config.start.provider)
    throw new Error('Cloud provider credentials do not match this session.');
  return result;
}

export function applyHostedProvider(
  env: Record<string, string>,
  credential: HostedCredential
): void {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CURSOR_API_KEY',
    'SWITCH_HOSTED_AUTH_JSON',
  ])
    delete env[key];
  if (credential.status === 'revoked')
    throw new Error(
      'The provider was disconnected. Reconnect it in Console before resuming this session.'
    );
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
  applyHostedProvider(env, credential);
  if (credential.status !== 'connected') return;
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

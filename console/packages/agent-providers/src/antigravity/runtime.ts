import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { StdioJsonRpcClient, type ProviderLogger } from '../transport/stdio-json-rpc';

export const ANTIGRAVITY_SIGN_IN =
  'Sign in to Antigravity ACP on the execution host with antigravity-acp --login. The ACP runtime has a separate login from agy.';

export async function createAntigravityClient(input: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  logger: ProviderLogger;
  onExit: (reason: string) => void;
}): Promise<StdioJsonRpcClient> {
  if (['agy', 'antigravity'].includes(basename(input.binaryPath)))
    throw new Error(
      'The selected executable is the old Antigravity CLI. Install and select antigravity-acp in provider setup.'
    );
  const profile =
    input.env.GEMINI_HOME ||
    join(input.env.HOME || homedir(), '.local', 'state', 'switch', 'antigravity-acp');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ auth: { type: 'oauth-personal' } }),
    { mode: 0o600, flag: 'wx' }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const raw = basename(input.binaryPath).startsWith('agy_acp_server');
  return new StdioJsonRpcClient({
    command: input.binaryPath,
    args: raw && process.platform === 'linux' ? ['--uid='] : [],
    cwd: input.cwd,
    env: {
      ...input.env,
      GEMINI_HOME: profile,
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      PYTHONUNBUFFERED: '1',
      BROWSER: 'false',
      ...(raw && isAbsolute(input.binaryPath)
        ? { ANTIGRAVITY_HARNESS_PATH: join(dirname(input.binaryPath), 'localharness_external') }
        : {}),
    },
    logger: input.logger,
    onExit: input.onExit,
    rejectOutputLine: (line) =>
      line.includes('Open the following link to authenticate the ACP server:')
        ? ANTIGRAVITY_SIGN_IN
        : undefined,
  });
}

/**
 * The ACP handshake, and nothing else.
 *
 * Deliberately does NOT sign in. The response's `authMethods` is the agent
 * saying which sign-ins are still outstanding, so this is the whole of what a
 * caller needs to ANSWER "is this signed in?" — and answering that question
 * must not change it. Signing in is {@link authenticateAntigravity}, called
 * only where the user has asked for work that needs it.
 */
export async function initializeAntigravity(client: StdioJsonRpcClient) {
  return await client.request<{
    agentCapabilities?: { sessionCapabilities?: { resume?: unknown } };
    authMethods?: { id?: string }[];
  }>('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'switch-console', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
}

/**
 * Sign in to the ACP server.
 *
 * **This opens a browser** when the profile holds no usable token — the OAuth
 * consent page, launched by the agent itself. `BROWSER=false` in the spawn env
 * asks it not to, and it is not obliged to listen, which is why the call site
 * matters more than the mitigation: only call this for work the user asked
 * for, never to find out whether it would be needed.
 */
export async function authenticateAntigravity(client: StdioJsonRpcClient) {
  await client.request('authenticate', { methodId: 'oauth-personal' });
}

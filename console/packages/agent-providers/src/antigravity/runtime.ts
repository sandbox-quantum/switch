import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, isAbsolute } from 'node:path';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

export const ANTIGRAVITY_SIGN_IN =
  'Sign in to Antigravity ACP on the execution host with antigravity-acp --login. The ACP runtime has a separate login from agy.';

/**
 * How `antigravity-acp` runs: in its own profile directory, set up for OAuth
 * on first use, and killed when it prints a sign-in link instead of answering.
 */
export async function antigravityLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
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
  return {
    command: input.binaryPath,
    args: raw && process.platform === 'linux' ? ['--uid='] : [],
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
    rejectOutputLine: (line) =>
      line.includes('Open the following link to authenticate the ACP server:')
        ? ANTIGRAVITY_SIGN_IN
        : undefined,
  };
}

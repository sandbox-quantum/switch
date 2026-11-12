import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, isAbsolute } from 'node:path';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

export const ANTIGRAVITY_SIGN_IN =
  'Sign in to Antigravity ACP on the execution host with antigravity-acp --login. The ACP runtime has a separate login from agy.';

/** The Gemini home an Antigravity ACP server runs with: its sign-in and settings live under it. */
export function antigravityProfile(env: Record<string, string>): string {
  return (
    env.GEMINI_HOME || join(env.HOME || homedir(), '.local', 'state', 'switch', 'antigravity-acp')
  );
}

/**
 * Whether the profile holds a consumer sign-in: the token file `--login`
 * writes, with a refresh token in it. Antigravity ACP 1.3 lists every sign-in
 * method in `initialize` whether or not one is in use, so the handshake no
 * longer says; the token itself is checked when a session signs in with it.
 */
export async function antigravitySignedIn(profile: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(profile, 'antigravity-acp', 'acp_token.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const token = JSON.parse(text) as Record<string, unknown> | null;
    return typeof token?.refresh_token === 'string' && token.refresh_token.length > 0;
  } catch {
    return false;
  }
}

/**
 * How `antigravity-acp` runs: in its own profile directory, set up for OAuth
 * on first use, and killed when it prints a sign-in link instead of answering.
 */
export async function antigravityLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  if (['agy', 'antigravity'].includes(basename(input.binaryPath)))
    throw new Error(
      'The selected executable is the old Antigravity CLI. Install and select antigravity-acp in provider setup.'
    );
  const profile = antigravityProfile(input.env);
  // Antigravity ACP up to 1.1 reads its settings at the profile's root; 1.3
  // reads them beside its token, in `antigravity-acp/`. Without the auth type
  // recorded, a signed-in profile answers `initialize` as signed out.
  for (const directory of [profile, join(profile, 'antigravity-acp')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ auth: { type: 'oauth-personal' } }),
      { mode: 0o600, flag: 'wx' }
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
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

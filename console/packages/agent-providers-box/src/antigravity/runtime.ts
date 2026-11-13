import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, isAbsolute } from 'node:path';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

/** The command that signs Google's Antigravity CLI in for its ACP server. */
export const AGY_LOGIN = 'agy acp --login';

export const ANTIGRAVITY_SIGN_IN = `Sign in to Antigravity on the execution host with ${AGY_LOGIN}, or set GEMINI_API_KEY.`;

/** How a retired Switch wrapper install is signed in: it keeps a profile of its own. */
/** The command that signs a retired Switch wrapper install in, into its own profile. */
export const LEGACY_ANTIGRAVITY_LOGIN = 'antigravity-acp --login';

export const LEGACY_ANTIGRAVITY_SIGN_IN = `Sign in to Antigravity ACP on the execution host with ${LEGACY_ANTIGRAVITY_LOGIN}, or install Google’s agy CLI and sign in with ${AGY_LOGIN}.`;

/**
 * Whether `binaryPath` is the ACP runtime Switch Console used to install
 * (`antigravity-acp`, the launcher around Google's `agy_acp_server.par`)
 * rather than Google's own `agy` CLI. Those installs keep working, in their
 * own profile, until the machine has `agy`.
 */
export function isLegacyAntigravityRuntime(binaryPath: string): boolean {
  const name = basename(binaryPath.replaceAll('\\', '/')).toLowerCase();
  return name.startsWith('antigravity-acp') || name.startsWith('agy_acp_server');
}

/** The command that signs in the Antigravity runtime at `binaryPath`. */
export function antigravityLoginCommand(binaryPath: string): string {
  return isLegacyAntigravityRuntime(binaryPath) ? LEGACY_ANTIGRAVITY_LOGIN : AGY_LOGIN;
}

/**
 * Whether `binaryPath` is the Antigravity IDE's command-line launcher, which
 * opens the editor (and would take `acp` for a folder to open) rather than
 * serving ACP.
 */
function isAntigravityIdeLauncher(binaryPath: string): boolean {
  const name = basename(binaryPath.replaceAll('\\', '/')).toLowerCase();
  return /^antigravity(\.(exe|cmd|bat))?$/.test(name);
}

/** The Gemini home a legacy Antigravity ACP server runs with: its sign-in and settings live under it. */
export function antigravityProfile(env: Record<string, string>): string {
  return (
    env.GEMINI_HOME || join(env.HOME || homedir(), '.local', 'state', 'switch', 'antigravity-acp')
  );
}

/**
 * Whether a legacy profile holds a consumer sign-in: the token file `--login`
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
 * How Antigravity runs. Google's `agy` serves ACP as `agy acp`, with the
 * user's own profile and sign-in, so nothing is set up for it. A legacy
 * `antigravity-acp` runs in its own profile directory, set up for OAuth on
 * first use, and is killed when it prints a sign-in link instead of answering.
 */
export async function antigravityLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  if (isAntigravityIdeLauncher(input.binaryPath))
    throw new Error(
      'The selected executable is the Antigravity IDE launcher, which does not serve ACP. Install Google’s agy CLI and select it in provider setup.'
    );
  if (!isLegacyAntigravityRuntime(input.binaryPath))
    return {
      command: input.binaryPath,
      args: ['acp'],
      env: { ...input.env, BROWSER: 'false' },
    };
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
        ? LEGACY_ANTIGRAVITY_SIGN_IN
        : undefined,
  };
}

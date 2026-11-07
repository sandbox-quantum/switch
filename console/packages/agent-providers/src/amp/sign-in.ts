import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

export const AMP_LOGIN = 'amp login';

const CHECK_TIMEOUT_MS = 15_000;

const SIGNED_OUT =
  /no (saved )?accounts?|not (logged|signed) in|not authenticated|run `?amp login/i;

/**
 * Reads `amp account list`, which names the saved accounts without signing
 * in. An account line carries an email or a user id; nothing listed, or a
 * line saying so, is signed out.
 */
export function parseAmpAccountList(stdout: string, stderr: string): ProviderReadiness {
  const output = `${stdout}\n${stderr}`;
  if (SIGNED_OUT.test(output)) return readiness('unauthenticated', signInWith(AMP_LOGIN));
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => /@|\buser[_ -]?id\b|\bactive\b|^\*/i.test(line)))
    return readiness('authenticated', 'Signed in.');
  if (lines.length === 0) return readiness('unauthenticated', signInWith(AMP_LOGIN));
  return readiness(
    'unknown',
    'Could not tell from `amp account list` whether Amp is signed in. Check provider setup and try again.'
  );
}

export async function checkAmpSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  if (input.env.AMP_API_KEY) return readiness('authenticated', 'Signed in with AMP_API_KEY.');
  try {
    const { stdout, stderr } = await execProvider(input.binaryPath, ['account', 'list'], {
      cwd: input.cwd,
      env: { ...input.env, AMP_SKIP_UPDATE_CHECK: '1' },
      timeout: CHECK_TIMEOUT_MS,
    });
    return parseAmpAccountList(stdout, stderr);
  } catch (error) {
    const stdout = commandOutput(error);
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr
        : '';
    if (SIGNED_OUT.test(`${stdout}\n${stderr}`))
      return readiness('unauthenticated', signInWith(AMP_LOGIN));
    return readiness(
      'unknown',
      `Could not run amp account list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

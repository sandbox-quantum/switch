import type { SignInCheckInput, ProviderReadiness } from '../readiness';
import { commandOutput, readiness, signInWith } from '../readiness';
import { execProvider } from '../provider-process';

export const AUGGIE_LOGIN = 'auggie auth login';

const SIGNED_OUT = /not logged in|not authenticated|not signed in|unauthenticated/i;
const SIGNED_IN = /\b(?:logged in|authenticated|signed in)\b/i;

/**
 * Parse the read-only `auggie auth status` result. Auggie 1.2.0 prerelease
 * prints "Not logged in." and exits 1 when signed out; an unrecognised result
 * stays unknown rather than being treated as authenticated.
 */
export function parseAuggieAuthStatus(output: string, exitCode: number | null): ProviderReadiness {
  if (SIGNED_OUT.test(output))
    return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  if (exitCode === 0 && SIGNED_IN.test(output))
    return readiness('authenticated', 'Signed in to Auggie.');
  return readiness(
    'unknown',
    'Could not verify Auggie authentication with `auggie auth status`. Check the CLI output and provider setup.'
  );
}

/** Checks Auggie's local auth state without starting its login flow. */
export async function checkAuggieSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  try {
    const result = await execProvider(input.binaryPath, ['auth', 'status'], {
      cwd: input.cwd,
      env: input.env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return parseAuggieAuthStatus(`${result.stdout}\n${result.stderr}`, 0);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const code = (error as { code?: unknown }).code;
    const output = [commandOutput(error), typeof stderr === 'string' ? stderr : '']
      .filter(Boolean)
      .join('\n');
    return parseAuggieAuthStatus(output, typeof code === 'number' ? code : null);
  }
}
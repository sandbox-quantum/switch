import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  commandOutput,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

export const CLAUDE_LOGIN = 'claude auth login';

export function parseClaudeAuthStatus(output: string): ProviderReadiness {
  const value = z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(output));
  if (!value.success)
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  return value.data.loggedIn
    ? readiness('authenticated', 'Signed in.')
    : readiness('unauthenticated', signInWith(CLAUDE_LOGIN));
}

export async function checkClaudeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let output: string;
  try {
    output = (
      await promisify(execFile)(input.binaryPath, ['auth', 'status'], {
        cwd: input.cwd,
        env: input.env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    output = commandOutput(error);
  }
  return parseClaudeAuthStatus(output);
}

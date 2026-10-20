import { z } from 'zod';
import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

export const CLAUDE_LOGIN = 'claude auth login';

/**
 * Said when `claude auth status` answers with something other than its JSON:
 * Claude Code from before that command (the early research preview) prints
 * its help or an error instead, and has no way to say whether it is signed in.
 */
export const CLAUDE_TOO_OLD =
  'Claude Code did not say whether it is signed in. It may be too old: update it with `claude update`, or reinstall it, then check again.';

export function parseClaudeAuthStatus(output: string): ProviderReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return readiness('unknown', CLAUDE_TOO_OLD);
  }
  const value = z.object({ loggedIn: z.boolean() }).safeParse(parsed);
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
      await execProvider(input.binaryPath, ['auth', 'status'], {
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

/**
 * What a one-line test prompt says about Claude Code's sign-in.
 *
 * `claude auth status` only says a login or key is there, not that it works:
 * a key left by an old install, or one revoked since, reads as signed in while
 * every session it starts fails. Asking for one short reply is the check that
 * the agent's own sessions will get answers.
 */
export function parseClaudeTestReply(output: string): ProviderReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim().split('\n').at(-1) ?? '');
  } catch {
    return readiness('unknown', CLAUDE_TOO_OLD);
  }
  const value = z
    .object({ is_error: z.boolean(), result: z.string().optional() })
    .safeParse(parsed);
  if (!value.success) return readiness('unknown', CLAUDE_TOO_OLD);
  if (!value.data.is_error)
    return readiness('authenticated', 'Signed in, and answered a test prompt.');
  const said = value.data.result?.trim();
  return readiness(
    'unauthenticated',
    `Claude Code is signed in but could not answer a test prompt${said ? ` ("${said.slice(0, 200)}")` : ''}. ${signInWith(CLAUDE_LOGIN)}`
  );
}

/**
 * Sends Claude Code one short prompt, as an agent session would, with no
 * tools, no MCP servers and nothing saved, and reads whether it answered.
 * Costs one small request, so it is for setting up and rechecks asked for,
 * not for every periodic check.
 */
export async function verifyClaudeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let output: string;
  try {
    output = (
      await execProvider(
        input.binaryPath,
        [
          '-p',
          'Reply with the word OK and nothing else.',
          '--output-format',
          'json',
          '--max-turns',
          '1',
          '--tools',
          '',
          '--strict-mcp-config',
          '--no-session-persistence',
        ],
        { cwd: input.cwd, env: input.env, timeout: 60_000, maxBuffer: 1024 * 1024 }
      )
    ).stdout;
  } catch (error) {
    if ((error as { killed?: boolean }).killed)
      return readiness('unknown', 'Claude Code did not answer a test prompt within a minute.');
    output = commandOutput(error);
  }
  return parseClaudeTestReply(output);
}

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
 * What a one-line test prompt says about Claude Code's sign-in, from what it
 * printed on stdout and on stderr.
 *
 * `claude auth status` only says a login or key is there, not that it works:
 * a key left by an old install, or one revoked since, reads as signed in while
 * every session it starts fails. Asking for one short reply is the check that
 * the agent's own sessions will get answers.
 */
export function parseClaudeTestReply(output: string, stderr = ''): ProviderReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim().split('\n').at(-1) ?? '');
  } catch {
    return withoutReply(stderr);
  }
  const value = z
    .object({
      is_error: z.boolean(),
      result: z.string().optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(parsed);
  if (!value.success) return withoutReply(stderr);
  if (!value.data.is_error)
    return readiness('authenticated', 'Signed in, and answered a test prompt.');
  // Claude puts what went wrong in `result`, or, for some failures and older
  // versions, only in `errors`, as the Claude adapter also reads it.
  const said =
    value.data.result?.trim() ||
    (value.data.errors ?? [])
      .filter((error): error is string => typeof error === 'string')
      .join('; ')
      .trim();
  return readiness(
    'unauthenticated',
    `Claude Code is signed in but could not answer a test prompt${said ? ` ("${said.slice(0, 200)}")` : ''}. ${signInWith(CLAUDE_LOGIN)}`
  );
}

/**
 * No JSON answer: a Claude Code too old for the test prompt's options says so
 * on stderr ("unknown option"), and any other failure is shown as Claude
 * worded it rather than guessed at. Not a sign-out either way: the login may
 * well work.
 */
function withoutReply(stderr: string): ProviderReadiness {
  const said = stderr.trim().split('\n').filter(Boolean).at(-1)?.trim() ?? '';
  if (!said || /unknown option|unknown argument/i.test(said))
    return readiness('unknown', CLAUDE_TOO_OLD);
  return readiness(
    'unknown',
    `Claude Code could not answer a test prompt ("${said.slice(0, 200)}").`
  );
}

/** How long the test prompt may take: well inside the minute and a half a Console recheck waits. */
export const CLAUDE_TEST_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Sends Claude Code one short prompt, as an agent session would, with no
 * tools, no MCP servers, no hooks and nothing saved, and reads whether it
 * answered. The person's settings still load, so the login and any key or
 * provider they configure are what is tried; only hooks are turned off, since
 * theirs could run commands, block, or make calls of their own. Costs one
 * small request, so it is for setting up and rechecks asked for, not for
 * every periodic check.
 */
export async function verifyClaudeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let output: string;
  let stderr = '';
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
          '--settings',
          '{"disableAllHooks":true}',
        ],
        {
          cwd: input.cwd,
          env: input.env,
          timeout: CLAUDE_TEST_PROMPT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }
      )
    ).stdout;
  } catch (error) {
    if ((error as { killed?: boolean }).killed)
      return readiness('unknown', 'Claude Code did not answer a test prompt within 30 seconds.');
    output = commandOutput(error);
    const errorStderr = (error as { stderr?: unknown }).stderr;
    if (typeof errorStderr === 'string') stderr = errorStderr;
  }
  return parseClaudeTestReply(output, stderr);
}

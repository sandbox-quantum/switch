import { z } from 'zod';
import { execProvider } from '../provider-process';
import { commandOutput, type SignInCheckInput } from '../readiness';
import { CLAUDE_TOO_OLD } from './sign-in';

export const claudeAuthStatusSchema = z.object({
  /** Whether `claude auth status` said a login or key is there: not that it works. */
  loggedIn: z.boolean(),
  /** How it is signed in, as Claude Code names it: `claude.ai`, `api_key`, `third_party`. */
  authMethod: z.string().nullable(),
  /** Whose API it calls, as Claude Code names it: `firstParty`, `bedrock`, `vertex`. */
  apiProvider: z.string().nullable(),
});
export type ClaudeAuthStatus = z.infer<typeof claudeAuthStatusSchema>;

/** What `claude auth status` prints, of which only these fields are read. */
const printedSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
});

/**
 * What `claude auth status` says of the Claude Code at `input.binaryPath`.
 * Throws where it does not answer with its JSON, as a Claude Code from before
 * that command does.
 */
export async function claudeAuthStatus(input: SignInCheckInput): Promise<ClaudeAuthStatus> {
  let output: string;
  try {
    output = (
      await execProvider(input.binaryPath, ['auth', 'status'], {
        cwd: input.cwd,
        env: input.env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    // Signed out, it says so in its JSON and exits nonzero.
    output = commandOutput(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(CLAUDE_TOO_OLD);
  }
  const printed = printedSchema.safeParse(parsed);
  if (!printed.success)
    throw new Error('`claude auth status` did not say whether it is signed in.');
  return {
    loggedIn: printed.data.loggedIn,
    authMethod: printed.data.authMethod ?? null,
    apiProvider: printed.data.apiProvider ?? null,
  };
}

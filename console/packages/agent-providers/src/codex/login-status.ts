import { z } from 'zod';
import { execProvider } from '../provider-process';
import type { SignInCheckInput } from '../readiness';

export const codexLoginStatusSchema = z.object({
  /** Whether `codex login status` said it is signed in: it exits 0 then. */
  loggedIn: z.boolean(),
  /** What it printed, as it said it: "Logged in using ChatGPT", say. */
  message: z.string(),
});
export type CodexLoginStatus = z.infer<typeof codexLoginStatusSchema>;

function printed(output: { stdout?: unknown; stderr?: unknown }): string {
  const text = [output.stdout, output.stderr].filter((part) => typeof part === 'string').join('\n');
  return text.trim();
}

/**
 * What `codex login status` says of the Codex at `input.binaryPath`: a read
 * of its own login, which it answers from the credentials it would use.
 */
export async function codexLoginStatus(input: SignInCheckInput): Promise<CodexLoginStatus> {
  try {
    const output = await execProvider(input.binaryPath, ['login', 'status'], {
      cwd: input.cwd,
      env: input.env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { loggedIn: true, message: printed(output) };
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
    // A Codex that ran and said it is not signed in exits nonzero; one that
    // did not run at all (it is not there) is a failure of the check.
    if (typeof output.code !== 'number') throw error;
    return { loggedIn: false, message: printed(output) };
  }
}

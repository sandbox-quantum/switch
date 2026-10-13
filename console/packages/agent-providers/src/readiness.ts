import { z } from 'zod';

export const providerReadinessSchema = z.object({
  status: z.enum(['authenticated', 'unauthenticated', 'unconfigured', 'unknown']),
  message: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;

/** Where a sign-in check runs: the provider's executable, in a directory, with an environment. */
export interface SignInCheckInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}

export function readiness(status: ProviderReadiness['status'], message: string): ProviderReadiness {
  return { status, message, models: [] };
}

export function signInWith(loginCommand: string): string {
  return `Sign in on the execution machine with ${loginCommand}.`;
}

/**
 * The output of a status command a signed-out CLI may answer with a nonzero
 * exit: its stdout either way, or '' when it printed none.
 */
export function commandOutput(error: unknown): string {
  return typeof (error as { stdout?: unknown }).stdout === 'string'
    ? (error as { stdout: string }).stdout
    : '';
}

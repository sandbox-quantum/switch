import { z } from 'zod';
import { claudeAuthStatus, claudeAuthStatusSchema } from './claude/auth-status';
import { verifyClaudeSignIn } from './claude/sign-in';
import { codexLoginStatus, codexLoginStatusSchema } from './codex/login-status';
import { providerRuntime } from './providers/registry';
import { loginCommandOf, providerReadinessSchema } from './readiness';

/**
 * Setup checks: what a provider's setup may ask the provider's runtime
 * to find out, run as its sessions run. A setup check only reads: it never
 * signs in, installs, or writes anything a session reads. The most one does
 * is send the provider a test prompt, which its name says.
 *
 * A provider has checks here only once it has one of its own to add; the
 * rest are still checked the legacy way. Each check is the provider's own,
 * with its own input and output, which its setup reads.
 */

/**
 * Legacy: the installation a session's configuration names for the
 * provider's runtime today, by its executable, as `execution.binaryPath`. To
 * go once installations are named in full.
 */
export type LegacyInstallationConfig = { binaryPath: string };

/** Where a setup check runs: the executable, in a directory, with the environment a session gets. */
export type CheckTarget = {
  installationConfig: LegacyInstallationConfig;
  cwd: string;
  env: Record<string, string>;
};

/** A setup check: its input and output, and how the runtime finds it out. */
export type SetupCheck<I extends z.ZodType, O extends z.ZodType> = {
  input: I;
  output: O;
  run: (target: CheckTarget, input: z.infer<I>) => Promise<z.infer<O>>;
};

export const SETUP_CHECKS = {
  claude: {
    /** What `claude auth status` says of the login or key it would use: not that it works. */
    'auth-status': {
      input: z.object({}),
      output: claudeAuthStatusSchema,
      run: (target: CheckTarget) =>
        claudeAuthStatus({
          binaryPath: target.installationConfig.binaryPath,
          cwd: target.cwd,
          env: target.env,
        }),
    },
    /** Sends Claude Code a one-word test prompt, which uses the account it is signed in to. */
    'test-prompt': {
      input: z.object({}),
      output: providerReadinessSchema,
      run: (target: CheckTarget) =>
        verifyClaudeSignIn({
          binaryPath: target.installationConfig.binaryPath,
          cwd: target.cwd,
          env: target.env,
        }),
    },
  },
  codex: {
    /** What `codex login status` says of the login it would use. */
    'login-status': {
      input: z.object({}),
      output: codexLoginStatusSchema,
      run: (target: CheckTarget) =>
        codexLoginStatus({
          binaryPath: target.installationConfig.binaryPath,
          cwd: target.cwd,
          env: target.env,
        }),
    },
  },
} satisfies Record<string, Record<string, SetupCheck<z.ZodType, z.ZodType>>>;

export type SetupCheckProvider = keyof typeof SETUP_CHECKS;
export type SetupCheckName<P extends SetupCheckProvider> = keyof (typeof SETUP_CHECKS)[P] & string;
type CheckOf<
  P extends SetupCheckProvider,
  K extends SetupCheckName<P>,
> = (typeof SETUP_CHECKS)[P][K];
export type SetupCheckInput<P extends SetupCheckProvider, K extends SetupCheckName<P>> =
  CheckOf<P, K> extends SetupCheck<infer I, z.ZodType> ? z.infer<I> : never;
export type SetupCheckOutput<P extends SetupCheckProvider, K extends SetupCheckName<P>> =
  CheckOf<P, K> extends SetupCheck<z.ZodType, infer O> ? z.infer<O> : never;

/**
 * What running a setup check came to: its output, or why there is none (no
 * such check here, what was asked is not valid, or the check failed). Never
 * thrown: a check that cannot run is one thing a setup reports, not
 * the end of it.
 */
export type SetupCheckResult = { ok: true; output: unknown } | { ok: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Runs `provider`'s setup check `check` on `installationConfig`, with `input`, checking what goes in and out. */
export async function runSetupCheck(request: {
  provider: string;
  check: string;
  installationConfig: LegacyInstallationConfig;
  input: unknown;
  cwd: string;
  env: Record<string, string>;
}): Promise<SetupCheckResult> {
  const checks: Record<string, SetupCheck<z.ZodType, z.ZodType>> | undefined =
    SETUP_CHECKS[request.provider as SetupCheckProvider];
  const check = checks?.[request.check];
  if (!check)
    return { ok: false, reason: `The ${request.provider} runtime has no check ${request.check}.` };
  const input = check.input.safeParse(request.input);
  if (!input.success) return { ok: false, reason: `Not an input: ${issues(input.error)}` };
  let output: unknown;
  try {
    output = await check.run(
      { installationConfig: request.installationConfig, cwd: request.cwd, env: request.env },
      input.data
    );
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const parsed = check.output.safeParse(output);
  if (!parsed.success) return { ok: false, reason: `Not an output: ${issues(parsed.error)}` };
  return { ok: true, output: parsed.data };
}

/** The command that signs `provider`'s executable at `installationConfig` in, for a person to finish. */
export function loginCommandFor(
  provider: string,
  installationConfig: LegacyInstallationConfig
): string {
  return loginCommandOf(providerRuntime(provider), installationConfig.binaryPath);
}

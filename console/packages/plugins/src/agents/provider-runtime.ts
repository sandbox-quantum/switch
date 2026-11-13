import type {
  SetupCheckInput,
  SetupCheckName,
  SetupCheckOutput,
  SetupCheckProvider,
} from '@switch-console/agent-providers';
import {
  checkStep,
  cliStep,
  step,
  type Executable,
  type RunSetupCheck,
  type LegacyInstallationConfig,
  type LegacyReadiness,
  type InstallationState,
  type RunContext,
  type SetupHost,
  type SignInStatus,
} from '@switch-console/core/agents/provider-setup';
import {
  code,
  rich,
  runActivity,
  type ActivityLog,
  type ActivityUpdate,
  type RichText,
} from '@switch-console/shared';

/**
 * What the provider setups share about their providers' runtimes: naming an
 * executable to the runtime, reading its sign-in, with the runtime's setup
 * checks or, on a runtime from before them, its legacy check, and signing in.
 */

/**
 * Legacy: how an executable is named to its provider's runtime today, by its
 * realpath. To go once installations are named in full.
 */
export function legacyInstallationConfig(executable: Executable): LegacyInstallationConfig {
  return { binaryPath: executable.realpath };
}

/** What reading a sign-in finds, for an installation's state. */
export type SignInFinding = { signIn: SignInStatus } & Pick<InstallationState, 'needsSignIn'>;

const SIGN_IN_OUTCOME = {
  'signed-in': rich`signed in`,
  'signed-out': rich`not signed in`,
  unknown: rich`could not tell`,
} as const;

/** `finding`, told in `update`'s activity. */
function told(finding: { signIn: SignInStatus; needsSignIn: boolean }, update: ActivityUpdate) {
  const { status, detail } = finding.signIn;
  update({ outcome: SIGN_IN_OUTCOME[status], description: detail ? rich`${detail}` : null });
  return finding;
}

/**
 * What a legacy readiness says of the sign-in, told in `update`'s activity.
 * Signed out with no backend configured, signing in would not help.
 */
function signInFrom(readiness: LegacyReadiness, update: ActivityUpdate): SignInFinding {
  const detail = readiness.message;
  switch (readiness.status) {
    case 'authenticated':
      return told({ signIn: { status: 'signed-in', detail }, needsSignIn: false }, update);
    case 'unauthenticated':
      return told({ signIn: { status: 'signed-out', detail }, needsSignIn: true }, update);
    case 'unconfigured':
      return told({ signIn: { status: 'signed-out', detail }, needsSignIn: false }, update);
    case 'unknown':
      return told({ signIn: { status: 'unknown', detail }, needsSignIn: false }, update);
  }
}

/** What could not be read of the sign-in, told in `update`'s activity. */
function signInUnknown(
  executable: Executable,
  reason: string,
  update: ActivityUpdate
): SignInFinding {
  update({
    status: 'failed',
    outcome: rich`could not check`,
    description: rich`${code(executable.path)}: ${reason}`,
  });
  return { signIn: { status: 'unknown', detail: reason }, needsSignIn: false };
}

/**
 * Whether `spec.executable` is signed in, by one of its provider's own setup
 * checks, whose output `spec.read` tells as a sign-in, as one activity in
 * `log`. Where the check cannot run, the sign-in is unknown and the activity
 * says why.
 */
export function setupCheckSignIn<P extends SetupCheckProvider, K extends SetupCheckName<P>>(
  runSetupCheck: RunSetupCheck,
  spec: {
    provider: P;
    check: K;
    input: SetupCheckInput<P, K>;
    executable: Executable;
    read: (output: SetupCheckOutput<P, K>) => { signIn: SignInStatus; needsSignIn: boolean };
  },
  log: ActivityLog
): Promise<SignInFinding> {
  return runActivity(
    log,
    'Checking the sign-in',
    rich`${code(spec.executable.path)}`,
    async (update) => {
      const result = await runSetupCheck({
        provider: spec.provider,
        check: spec.check,
        installationConfig: legacyInstallationConfig(spec.executable),
        input: spec.input,
      });
      if (!result.ok) return signInUnknown(spec.executable, result.reason, update);
      // The runtime checked it against the check's own output schema.
      return told(spec.read(result.output as SetupCheckOutput<P, K>), update);
    }
  );
}

/**
 * Legacy: whether `executable` is signed in, by the check of a runtime from
 * before setup checks, as one activity in `log`.
 */
export function legacyCheckSignIn(
  s: { host: SetupHost },
  provider: string,
  executable: Executable,
  log: ActivityLog
): Promise<SignInFinding> {
  return runActivity(
    log,
    'Checking the sign-in',
    rich`${code(executable.path)}`,
    async (update) => {
      const result = await s.host.runLegacyCheck(provider, legacyInstallationConfig(executable));
      if (!result.ok) return signInUnknown(executable, result.reason, update);
      return signInFrom(result.output, update);
    }
  );
}

/**
 * Legacy: verifies `executable`, the installation that runs by default, by a
 * controller's recheck, which may send a test prompt the provider bills; what
 * it found goes in `run`'s findings.
 */
export async function legacyRecheckSignIn(
  s: { host: SetupHost },
  run: RunContext,
  provider: string,
  executable: Executable
): Promise<void> {
  const found = await runActivity(
    run.activity,
    'Rechecking the sign-in',
    rich`${code(executable.path)}`,
    async (update) => {
      const result = await s.host.runLegacyRecheck(provider);
      if (!result.ok) return signInUnknown(executable, result.reason, update);
      return signInFrom(result.output, update);
    }
  );
  run.findings.signIn = found.signIn;
  run.findings.needsSignIn = found.needsSignIn;
}

/**
 * The step of verifying `executable` that only a person can take, where
 * nothing here can verify it: starting a session with it, or running
 * `command` where the provider has one that sends it a prompt, and seeing
 * that it answers. `name` is the provider as a person calls it.
 */
export async function manualVerifyStep(
  run: RunContext,
  executable: Executable,
  name: string,
  command: string | null
): Promise<void> {
  await step(
    run,
    {
      id: 'test-connection',
      title: `Testing ${name}'s connection`,
      description: [
        command
          ? {
              kind: 'paragraph',
              text: rich`Run this yourself on this computer, and see that ${name} answers.`,
            }
          : {
              kind: 'paragraph',
              text: rich`Start a session with ${name} at ${code(executable.path)}, and see that it answers.`,
            },
        ...(command ? [{ kind: 'cli' as const, command }] : []),
      ],
    },
    null
  );
}

/**
 * A step of an installation's verify: one of its provider's setup checks, run
 * on `executable`, whose output `describe` tells as the step's outcome and
 * description. Gives the output; null where the check could not run.
 */
export function setupCheckStep<P extends SetupCheckProvider, K extends SetupCheckName<P>>(
  run: RunContext,
  runSetupCheck: RunSetupCheck,
  spec: {
    provider: P;
    check: K;
    input: SetupCheckInput<P, K>;
    executable: Executable;
    title: string;
    describe: (output: SetupCheckOutput<P, K>) => { outcome: RichText; description: RichText };
  }
): Promise<SetupCheckOutput<P, K> | null> {
  return checkStep(
    run,
    { title: spec.title, description: rich`${code(spec.executable.path)}` },
    async (update) => {
      const result = await runSetupCheck({
        provider: spec.provider,
        check: spec.check,
        installationConfig: legacyInstallationConfig(spec.executable),
        input: spec.input,
      });
      if (!result.ok) throw new Error(result.reason);
      // The runtime checked it against the check's own output schema.
      const output = result.output as SetupCheckOutput<P, K>;
      update(spec.describe(output));
      return output;
    }
  );
}

/**
 * The step that signs `executable` in with `provider`'s sign-in command,
 * which the person finishes where it asks; `name` is the provider as a
 * person calls it.
 */
export async function signInStep(
  s: { host: SetupHost },
  run: RunContext,
  provider: string,
  executable: Executable,
  name: string
): Promise<void> {
  await cliStep(s, run, {
    id: 'sign-in',
    title: `Signing in to ${name}`,
    description: [rich`Finish signing in where ${name} asks you to, usually in your browser.`],
    command: s.host.loginCommand(provider, legacyInstallationConfig(executable)),
  });
}

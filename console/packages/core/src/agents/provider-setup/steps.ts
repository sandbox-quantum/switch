import {
  addActivity,
  noActivity,
  code,
  lines,
  rich,
  runActivity,
  type ActivityLog,
  type ActivityUpdate,
  type RichText,
} from '@switch-console/shared';
import type {
  InstallCommandError,
  InstallCommandSpec,
} from '../../host-dependencies/runtime/types';
import { installationId, addInstallation } from './executables';
import type {
  Action,
  InstallationActions,
  InstallationSetupContext,
  InstallationState,
  ProviderSetup,
  RunContext,
  SetupContext,
  SetupHost,
  Step,
  StepBlock,
  StepFailure,
  UpdateCheck,
} from './types';

/** Thrown by {@link runCommand} for a command that failed, carrying how. */
class CommandFailed extends Error {
  constructor(readonly failure: InstallCommandError) {
    super(failure.message);
  }
}

function failureOf(error: unknown): StepFailure {
  if (error instanceof CommandFailed) return error.failure;
  return { type: 'step-failed', message: error instanceof Error ? error.message : String(error) };
}

/** A run context authorizing `authorized`, reporting to `activity`, with nothing done yet. */
export function runContext(
  authorized: RunContext['authorized'],
  activity: ActivityLog
): RunContext {
  return { activity, authorized, done: [], manual: [], failure: null, findings: {} };
}

function authorizes(run: RunContext, id: string): boolean {
  return run.authorized.includes(id);
}

/** A step's description as one activity's: each block on a line, a command line as code. */
function activityDescription(blocks: StepBlock[]): RichText | null {
  if (blocks.length === 0) return null;
  return lines(
    ...blocks.map((block) =>
      block.kind === 'paragraph' ? block.text : rich`${code(block.command)}`
    )
  );
}

/**
 * One step of an action: runs `fn` where `run` authorizes the step and
 * nothing before it in the action failed; otherwise leaves the step to a
 * person, in `run.manual`. Without `fn`, only a person can take it. Where
 * `fn` throws, the failure is recorded in `run.failure`, so the steps after
 * it are left to a person too. Either way it is reported as an activity.
 */
export async function step(
  run: RunContext,
  spec: Step,
  fn: (() => Promise<void>) | null
): Promise<void> {
  const description = activityDescription(spec.description);
  if (!fn || run.failure || !authorizes(run, spec.id)) {
    run.manual.push(spec);
    addActivity(run.activity, {
      title: spec.title,
      status: 'waiting',
      outcome: fn && run.failure ? rich`not run` : rich`needs you`,
      description,
    });
    return;
  }
  try {
    await runActivity(run.activity, spec.title, description, fn);
  } catch (error) {
    run.failure = failureOf(error);
    return;
  }
  run.done.push({ id: spec.id });
}

/**
 * One step of a check: it changes nothing, so it runs whatever `run`
 * authorizes, as an activity, and gives what `fn` found. It finds things out
 * rather than doing them, so it is neither done nor left to a person, and
 * where `fn` throws the activity says so, the action goes on, and it gives
 * null.
 */
export async function checkStep<T>(
  run: RunContext,
  spec: { title: string; description: RichText | null },
  fn: (update: ActivityUpdate) => Promise<T>
): Promise<T | null> {
  try {
    return await runActivity(run.activity, spec.title, spec.description, fn);
  } catch {
    // The activity says how it failed.
    return null;
  }
}

/**
 * Runs `command`, which changes the machine, throwing where it fails; then
 * reloads the shell's environment, as an installer may have changed PATH.
 */
export async function runCommand(
  s: { host: SetupHost },
  command: InstallCommandSpec
): Promise<void> {
  const result = await s.host.runCommand(command);
  if (!result.success) throw new CommandFailed(result.error);
  await s.host.exec.refreshShellEnv?.();
}

/**
 * `command` written out for a person to read and type. A command given as a
 * program and its arguments (an executable by its path, which may have
 * spaces) runs without a shell; written out, a part with spaces is quoted.
 */
function formatCommandForDisplay(command: InstallCommandSpec): string {
  if (typeof command === 'string') return command;
  return [command.command, ...command.args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
}

/**
 * A step that runs one command ({@link step}, {@link runCommand}), described
 * by `description` and then the command line.
 */
export async function cliStep(
  s: { host: SetupHost },
  run: RunContext,
  spec: { id: string; title: string; description: RichText[]; command: InstallCommandSpec }
): Promise<void> {
  const { command } = spec;
  await step(
    run,
    {
      id: spec.id,
      title: spec.title,
      description: [
        ...spec.description.map((text): StepBlock => ({ kind: 'paragraph', text })),
        { kind: 'cli', command: formatCommandForDisplay(command) },
      ],
    },
    () => runCommand(s, command)
  );
}

/**
 * A context for a check on `host`, reporting to `activity`, with nothing
 * found yet, which looks at `pinnedExecutables` besides PATH.
 */
export function setupContext(
  host: SetupHost,
  activity: ActivityLog,
  pinnedExecutables: readonly string[]
): SetupContext {
  const s: SetupContext = {
    host,
    activity,
    pinnedExecutables,
    state: { installations: [], defaultInstallation: null },
    actions: { install: [] },
    addInstallMethod: (offer) => {
      s.actions.install.push(offer);
    },
    addInstallation: (executable, details, check) => addInstallation(s, executable, details, check),
    setDefaultInstallation: (executable) => {
      s.state.defaultInstallation = executable && installationId(executable);
    },
    installationChecks: {},
  };
  return s;
}

/** What an installation's check found: its state, the actions on it, and how to check it for updates. */
export type InstallationFound = {
  state: InstallationState;
  actions: InstallationActions;
  updateCheck: UpdateCheck | null;
};

/** Checks installation `id`, listed by the check in `s`, reporting to `activity`. */
export async function checkInstallation(
  s: SetupContext,
  id: string,
  activity: ActivityLog
): Promise<InstallationFound> {
  const listed = s.installationChecks[id];
  const installation = s.state.installations.find((each) => each.id === id);
  if (!listed || !installation) throw new Error(`The check lists no installation ${id}.`);
  let actions = null as InstallationActions | null;
  let updateCheck: UpdateCheck | null = null;
  const i: InstallationSetupContext = {
    host: s.host,
    activity,
    installation,
    state: { signIn: null, needsSignIn: false, latestVersion: null, updateAvailable: null },
    setActions: (given) => {
      actions = given;
    },
    setUpdateCheck: (check) => {
      updateCheck = check;
    },
  };
  await listed.check(i);
  if (!actions) throw new Error(`The check of ${id} gave it no actions.`);
  return { state: i.state, actions, updateCheck };
}

/** What a whole check found: the provider's, and each installation's, by its id. */
export type CheckFound = { s: SetupContext; installations: Record<string, InstallationFound> };

/**
 * Checks with `setup` on `host`, looking at `pinnedExecutables` besides PATH,
 * then each installation it lists, reporting to `activity`.
 */
export async function checkAll(
  setup: ProviderSetup,
  host: SetupHost,
  activity: ActivityLog,
  pinnedExecutables: readonly string[]
): Promise<CheckFound> {
  const s = setupContext(host, activity, pinnedExecutables);
  await setup.check(s);
  const installations: Record<string, InstallationFound> = {};
  for (const { id } of s.state.installations)
    installations[id] = await checkInstallation(s, id, activity);
  return { s, installations };
}

/**
 * Checks with `setup`, runs the action `pick` picks from what it found, as
 * `authorized` lets it, reporting what it does to `activity`, and, where a
 * step ran, checks again: what it gives is the state the machine is in now.
 */
export async function runAction(
  setup: ProviderSetup,
  host: SetupHost,
  pinnedExecutables: readonly string[],
  pick: (found: CheckFound) => Action | null | undefined,
  authorized: RunContext['authorized'],
  activity: ActivityLog
): Promise<{ run: RunContext; found: CheckFound }> {
  // The checks around the action are what it starts from and leaves: they
  // are not reported among what the action does.
  const before = await checkAll(setup, host, noActivity, pinnedExecutables);
  const action = pick(before);
  if (!action) throw new Error('There is no such action from the state the check found.');
  const run = runContext(authorized, activity);
  await action(run);
  if (run.done.length === 0) return { run, found: before };
  return { run, found: await checkAll(setup, host, noActivity, pinnedExecutables) };
}

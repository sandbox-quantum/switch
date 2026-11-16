import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  loginCommandFor,
  providerRuntime,
  runSetupCheck,
  verifyClaudeSignIn,
} from '@switch-console/agent-providers';
import {
  checkAll,
  checkForUpdates,
  runContext,
  type Action,
  type CheckFound,
  type InstallationState,
  type ManualStep,
  type SetupHost,
} from '@switch-console/core/agents/provider-setup';
import { toPlatform } from '@switch-console/core/deps/runtime';
import { providerSetups } from '@switch-console/plugins/provider-setup';
import { activityLog, noActivity, type ActivityLog } from '@switch-console/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type {
  ProviderSetupAuthorization,
  ProviderSetupInstallation,
  ProviderSetupOperation,
  ProviderSetupRun,
  ProviderSetupSnapshot,
} from '@shared/core/provider-setup/provider-setup';
import { providerSetupChannel } from '@shared/events/appEvents';
import { clearResolvedPathCache } from '../agent-runtime/impl/resolve-agent-executable';
import { localDependencyManager } from '../dependencies/dependency-managers';
import { hostDependencyStore } from '../dependencies/host-dependency-store';
import { LocalExecutionContext } from '../execution-context/local-execution-context';
import { resolveLocalAutomationShellWithSystemFallback } from '../terminal-shell/resolver';
import { runSetupCommand, stopSetupCommand } from './command-runner';

/** The environment checks run with here: this process's own, as sessions on this computer get it. */
function sessionEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shell a step's commands run in here, as the dependency manager picks it. */
function setupShell() {
  return resolveLocalAutomationShellWithSystemFallback({ intent: 'system', onFallback: () => {} });
}

function setupOf(provider: string) {
  const setup = providerSetups[provider];
  if (!setup) throw new Error(`There is no setup for ${provider}.`);
  return setup;
}

/** Runs kept per provider; the oldest go first. */
const MAX_RUNS = 10;

/** How long a check is taken as current when the sheet opens again. */
const CHECK_FRESH_MS = 60_000;

/** What `operation` came to, in a few words, for a run that ran a step or failed. */
const DONE: Record<ProviderSetupOperation['kind'], string> = {
  check: 'Checked',
  install: 'Installed',
  verify: 'Connection tested',
  checkForUpdates: 'Checked for updates',
  update: 'Updated',
  uninstall: 'Uninstalled',
  signIn: 'Signed in',
};

/** The steps `action` would take, listed by running it with nothing authorized. */
async function stepsOf(action: Action): Promise<ManualStep[]> {
  const run = runContext([], noActivity);
  await action(run);
  return run.manual;
}

/** One provider's setup on this computer: the last check, and what is running. */
type ProviderEntry = {
  snapshot: ProviderSetupSnapshot;
  /** What the last check found, whose actions are run from. */
  found: CheckFound | null;
  /** What actions found out about each installation, by its id, laid over what its check found. */
  findings: Record<string, Partial<InstallationState>>;
  /** Where the commands of the run under way print to. */
  onLine: ((line: string) => void) | null;
  /** The command running, to stop it. */
  child: ChildProcess | null;
  /** Whether the person stopped the run under way. */
  stopped: boolean;
};

/**
 * Runs agent providers' setups on this computer for Switch Console, and
 * decides what to run for each thing a person does:
 *
 * - opening a provider's settings, or Refresh: its check, a check for updates
 *   of the installation in use, and the steps of each action on offer, by
 *   running it with nothing authorized;
 * - running an action, or one of its steps: that, with it authorized, then
 *   all of the above again, as part of the same run;
 * - choosing an installation: saving it, as sessions here read it, then a
 *   refresh.
 *
 * Each change is sent to the renderer whole, as a {@link ProviderSetupSnapshot}.
 */
class ProviderSetupService {
  private readonly entries = new Map<string, ProviderEntry>();

  private entry(provider: string): ProviderEntry {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = {
        snapshot: { provider, checked: null, running: null, runs: [], error: null },
        found: null,
        findings: {},
        onLine: null,
        child: null,
        stopped: false,
      };
      this.entries.set(provider, entry);
    }
    return entry;
  }

  private publish(entry: ProviderEntry, patch: Partial<ProviderSetupSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    events.emit(providerSetupChannel, entry.snapshot);
  }

  /** This computer, as `provider`'s setup sees it: commands it runs print to the run under way. */
  private hostFor(entry: ProviderEntry): SetupHost {
    return {
      platform: toPlatform(process.platform),
      exec: new LocalExecutionContext(),
      runCommand: async (command) =>
        runSetupCommand(
          command,
          await setupShell(),
          (line) => entry.onLine?.(line),
          (child) => {
            entry.child = child;
          }
        ).finally(() => {
          entry.child = null;
        }),
      runSetupCheck: (request) => runSetupCheck({ ...request, cwd: homedir(), env: sessionEnv() }),
      runLegacyCheck: async (provider, installationConfig) => {
        try {
          const readiness = await providerRuntime(provider).checkSignIn({
            binaryPath: installationConfig.binaryPath,
            cwd: homedir(),
            env: sessionEnv(),
          });
          return { ok: true, output: { status: readiness.status, message: readiness.message } };
        } catch (error) {
          return { ok: false, reason: errorMessage(error) };
        }
      },
      runLegacyRecheck: async (provider) => {
        // As a controller rechecks: the CLI it finds on PATH, by the provider's
        // own check, then, signed in, by a test prompt where the provider has one.
        try {
          const binaryPath = (await localDependencyManager.probe(provider)).path;
          if (!binaryPath) return { ok: false, reason: `There is no ${provider} on PATH.` };
          const input = { binaryPath, cwd: homedir(), env: sessionEnv() };
          const readiness = await providerRuntime(provider).checkSignIn(input);
          const tested =
            readiness.status === 'authenticated' && provider === 'claude'
              ? await verifyClaudeSignIn(input)
              : readiness;
          return { ok: true, output: { status: tested.status, message: tested.message } };
        } catch (error) {
          return { ok: false, reason: errorMessage(error) };
        }
      },
      loginCommand: loginCommandFor,
    };
  }

  /** Starts a run of `operation`, recorded as it goes, and gives what records into it. */
  private startRun(entry: ProviderEntry, operation: ProviderSetupOperation) {
    const id = randomUUID();
    const record: ProviderSetupRun = {
      id,
      operation,
      activities: [],
      output: [],
      manual: [],
      failure: null,
      summary: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    const change = (patch: Partial<ProviderSetupRun>) =>
      this.publish(entry, {
        runs: entry.snapshot.runs.map((run) => (run.id === id ? { ...run, ...patch } : run)),
      });
    this.publish(entry, {
      running: operation,
      runs: [...entry.snapshot.runs, record].slice(-MAX_RUNS),
    });
    const activity: ActivityLog = activityLog((activities) =>
      change({ activities: [...activities] })
    );
    entry.onLine = (line) => {
      const run = entry.snapshot.runs.find((each) => each.id === id);
      if (run) change({ output: [...run.output, line] });
    };
    return {
      activity,
      finish: (
        summary: string,
        failure: ProviderSetupRun['failure'],
        manual: ProviderSetupRun['manual']
      ) => {
        entry.onLine = null;
        change({ summary, failure, manual, finishedAt: Date.now() });
        this.publish(entry, { running: null });
      },
    };
  }

  /** The current snapshot of `provider`, refreshing it where it is not current. */
  get(provider: string): ProviderSetupSnapshot {
    const entry = this.entry(provider);
    const checked = entry.snapshot.checked;
    if (!entry.snapshot.running && (!checked || Date.now() - checked.at > CHECK_FRESH_MS))
      void this.refresh(provider);
    return entry.snapshot;
  }

  /** Checks `provider` again, as its own run. */
  async refresh(provider: string): Promise<void> {
    const entry = this.entry(provider);
    if (entry.snapshot.running) return;
    const run = this.startRun(entry, { kind: 'check' });
    try {
      await this.check(provider, entry, run.activity);
      run.finish(DONE.check, null, []);
    } catch (error) {
      log.warn('Checking an agent provider failed', { provider, error: errorMessage(error) });
      this.publish(entry, { error: errorMessage(error) });
      run.finish('Could not check', { type: 'step-failed', message: errorMessage(error) }, []);
    }
  }

  /**
   * Checks `provider`, reporting to `activity`: its check, a check for updates
   * of the installation in use where none is known, then the steps of each
   * action, which goes in the snapshot.
   */
  private async check(
    provider: string,
    entry: ProviderEntry,
    activity: ActivityLog
  ): Promise<void> {
    const setup = setupOf(provider);
    // The executable chosen for sessions here, which the check looks at
    // wherever it is; one chosen by its command is not an executable.
    const selection = await hostDependencyStore.getSelection('local', provider);
    const pinned =
      selection?.kind === 'pinned'
        ? selection.realpath
        : selection?.kind === 'path'
          ? await realpath(selection.path).catch(() => selection.path)
          : null;
    const found = await checkAll(setup, this.hostFor(entry), activity, pinned ? [pinned] : []);
    entry.found = found;
    const { state } = found.s;

    const chosen = pinned
      ? (setup.realpathToInstallation(state.installations, pinned)?.id ?? null)
      : null;
    // A method saved is how to install it, not which executable runs.
    const usesOther = selection !== null && selection.kind !== 'method' && chosen === null;
    const preferredOption =
      selection?.kind === 'method' &&
      found.s.actions.install.some((offer) => offer.id === selection.method)
        ? selection.method
        : null;
    const used = usesOther ? null : (chosen ?? state.defaultInstallation);

    const usedCheck = used ? found.installations[used]?.updateCheck : null;
    const usedInstallation = state.installations.find((each) => each.id === used);
    if (used && usedCheck && usedInstallation && !entry.findings[used]?.latestVersion)
      entry.findings[used] = {
        ...entry.findings[used],
        ...(await checkForUpdates(usedInstallation, usedCheck, activity)),
      };

    const installations: ProviderSetupInstallation[] = [];
    for (const installation of state.installations) {
      const { state: checkedState, actions, updateCheck } = found.installations[installation.id]!;
      installations.push({
        ...installation,
        ...checkedState,
        ...entry.findings[installation.id],
        can: {
          checkForUpdates: updateCheck !== null,
          update: actions.update !== null,
          uninstall: actions.uninstall !== null,
        },
        steps: {
          update: actions.update && (await stepsOf(actions.update)),
          uninstall: actions.uninstall && (await stepsOf(actions.uninstall)),
          signIn: await stepsOf(actions.signIn),
        },
      });
    }
    const installOptions = [];
    for (const { action, ...offer } of found.s.actions.install)
      installOptions.push({ ...offer, steps: await stepsOf(action) });

    this.publish(entry, {
      error: null,
      checked: {
        installations,
        defaultInstallation: state.defaultInstallation,
        used,
        chosen: chosen !== null,
        usesOther,
        installOptions,
        preferredOption,
        at: Date.now(),
      },
    });
  }

  /** The action `operation` names, from the last check of `entry`. */
  private actionOf(entry: ProviderEntry, operation: ProviderSetupOperation): Action | null {
    const found = entry.found;
    if (!found) return null;
    switch (operation.kind) {
      case 'check':
      case 'checkForUpdates':
        return null;
      case 'install':
        return (
          found.s.actions.install.find((offer) => offer.id === operation.option)?.action ?? null
        );
      case 'verify':
      case 'update':
      case 'uninstall':
      case 'signIn':
        return found.installations[operation.installation]?.actions[operation.kind] ?? null;
    }
  }

  /**
   * Runs `operation` on `provider` as `authorized` lets it, as its own run,
   * then checks again as part of it.
   */
  async run(
    provider: string,
    operation: ProviderSetupOperation,
    authorized: ProviderSetupAuthorization
  ): Promise<void> {
    const entry = this.entry(provider);
    if (entry.snapshot.running) throw new Error('Something is already running for this provider.');
    if (operation.kind === 'checkForUpdates')
      return this.checkForUpdates(provider, entry, operation);
    const action = this.actionOf(entry, operation);
    if (!action) throw new Error('There is no such action from the state the check found.');
    const recorded = this.startRun(entry, operation);
    const run = runContext(authorized, recorded.activity);
    entry.stopped = false;
    try {
      await action(run);
      if (entry.stopped) {
        await this.check(provider, entry, recorded.activity);
        recorded.finish('Stopped', null, []);
        return;
      }
      if (operation.kind !== 'install' && operation.kind !== 'check')
        entry.findings[operation.installation] = {
          ...entry.findings[operation.installation],
          ...run.findings,
        };
      // A change to the machine may change what was found out before.
      if (run.done.length > 0) entry.findings = {};
      await this.check(provider, entry, recorded.activity);
      recorded.finish(
        run.failure
          ? 'Failed'
          : run.done.length > 0 || (operation.kind === 'verify' && run.manual.length === 0)
            ? DONE[operation.kind]
            : 'Needs you',
        run.failure,
        run.manual
      );
    } catch (error) {
      log.warn('An agent provider setup action failed', { provider, error: errorMessage(error) });
      recorded.finish('Failed', { type: 'step-failed', message: errorMessage(error) }, []);
    }
  }

  /** Checks an installation of `provider` for updates, as its own run. */
  private async checkForUpdates(
    provider: string,
    entry: ProviderEntry,
    operation: ProviderSetupOperation & { kind: 'checkForUpdates' }
  ): Promise<void> {
    const id = operation.installation;
    const check = entry.found?.installations[id]?.updateCheck;
    const installation = entry.found?.s.state.installations.find((each) => each.id === id);
    if (!check || !installation) throw new Error('Nothing tells the latest version of this one.');
    const recorded = this.startRun(entry, operation);
    try {
      entry.findings[id] = {
        ...entry.findings[id],
        ...(await checkForUpdates(installation, check, recorded.activity)),
      };
      await this.check(provider, entry, recorded.activity);
      recorded.finish(DONE.checkForUpdates, null, []);
    } catch (error) {
      log.warn('Checking an agent provider for updates failed', {
        provider,
        error: errorMessage(error),
      });
      recorded.finish('Failed', { type: 'step-failed', message: errorMessage(error) }, []);
    }
  }

  /** Stops the command `provider`'s run is waiting on. */
  stop(provider: string): void {
    const entry = this.entry(provider);
    if (!entry.child) return;
    entry.stopped = true;
    stopSetupCommand(entry.child);
  }

  /**
   * Chooses `installation` of `provider` for sessions here, or, with null,
   * whichever runs by default; then checks again.
   */
  async use(provider: string, installation: string | null): Promise<void> {
    const entry = this.entry(provider);
    const listed = entry.found?.s.state.installations.find((each) => each.id === installation);
    if (installation !== null && !listed)
      throw new Error(`There is no installation ${installation}.`);
    await hostDependencyStore.setSelection(
      'local',
      provider,
      listed ? { kind: 'pinned', realpath: setupOf(provider).installationToRealpath(listed) } : null
    );
    clearResolvedPathCache(provider);
    await this.refresh(provider);
  }

  /**
   * Chooses the executable at `path` for sessions here, wherever it is, by
   * where it really is, as an installation found on PATH is chosen; then
   * checks again, which lists it.
   */
  async useExecutable(provider: string, path: string): Promise<void> {
    let found: string;
    try {
      found = await realpath(path);
    } catch {
      throw new Error(`There is nothing at ${path}.`);
    }
    await hostDependencyStore.setSelection('local', provider, { kind: 'pinned', realpath: found });
    clearResolvedPathCache(provider);
    await this.refresh(provider);
  }
}

export const providerSetupService = new ProviderSetupService();

/**
 * Wires the setup runner to a real remote host (CHOO-1809).
 *
 * The runner is deliberately ignorant of SSH, dependency managers and plugin
 * registries — it only knows how to sequence steps. This module supplies the
 * `check` and `install` implementations for each step kind, and owns the
 * per-host lifecycle (build, resume, run, skip, discard).
 */

import type { DependencyId, HostDependencyManager } from '@switch-console/core/deps/runtime';
import { agentUpdateService } from '@main/core/dependencies/agent-update-service';
import { CORE_DEPENDENCIES } from '@main/core/dependencies/core-dependencies';
import { installOutput } from '@main/core/dependencies/install-output';
import {
  getRemoteDependencyManager,
  remoteDependencyDescriptor,
} from '@main/core/dependencies/remote-dependency-manager';
import { listPlugins } from '@main/core/providers/plugin-registry';
import { getRemoteSwitchSetupService } from '@main/core/switch-setup/remote-switch-setup';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  hostSetupActivityEventChannel,
  hostSetupPlanEventChannel,
  type HostSetupPlan,
  type HostSetupStep,
} from '@shared/core/remote-hosts/setup';
import { probeGhAuthStatus } from '../gh-auth';
import { hostReachabilityService } from '../production-host-reachability';
import { HostSetupRunner, type StepCheckResult, type StepInstallResult } from './host-setup-runner';
import { InstallProgressReader } from './install-progress';
import {
  agentPluginStepId,
  buildSetupPlan,
  GH_AUTH_STEP_ID,
  reconcileInterruptedPlan,
} from './plan-builder';
import { deleteSetupPlan, getSetupPlan, listSetupPlans, saveSetupPlan } from './setup-plan-store';
import {
  condenseCommandOutput,
  describeInstallFailure,
  outcomeForDependency,
  outcomeForGhAuth,
} from './step-outcomes';

/** Runners are per-host so two hosts can be set up at once, but a host only once. */
const runners = new Map<string, HostSetupRunner>();

/**
 * Agent types worth planning for: those whose connector Switch Console can drive.
 *
 * Read from the plugin registry, not from the host. Whether a type is
 * *supported* is a static fact about the plugin — its `switchSetup` dialect and
 * the binary it names — and asking the host meant running every agent type's
 * CLI over SSH on every plan build, purely to be told what the registry already
 * knew. Whether a type is *installed* is a per-host question, and that is what
 * the plan's own steps are for.
 */
function plannableAgentTypes() {
  return listPlugins()
    .filter(
      (plugin) =>
        plugin.capabilities.switchSetup.kind === 'cli' &&
        plugin.capabilities.hostDependency.binaryNames.length > 0
    )
    .map((plugin) => ({
      agentId: plugin.metadata.id,
      name: remoteDependencyDescriptor(plugin.metadata.id)?.name ?? plugin.metadata.id,
    }));
}

/**
 * Build or refresh a host's plan. Rebuilding merges onto whatever was
 * persisted, so progress is preserved when the known dependency set changes,
 * and any step interrupted by the app closing is reset to pending rather than
 * left claiming a state nobody verified.
 */
export async function ensureSetupPlan(sshHost: string): Promise<HostSetupPlan> {
  const existing = await getSetupPlan(sshHost);
  const now = new Date().toISOString();

  const plan = buildSetupPlan({
    sshHost,
    coreDependencies: CORE_DEPENDENCIES.map((dep) => ({ id: dep.id, name: dep.name })),
    agentTypes: plannableAgentTypes(),
    existing: existing ? reconcileInterruptedPlan(existing, now) : null,
    now,
  });

  await saveSetupPlan(plan);
  events.emit(hostSetupPlanEventChannel, plan);
  return plan;
}

/**
 * Every host's plan, with its step *set* brought up to date first.
 *
 * Feeds the renderer store that the sidebar and the agent-creation gate read —
 * both need readiness for hosts whose page nobody has opened.
 *
 * Which steps a plan has is derived from the local plugin registry and costs no
 * SSH, so it can be recomputed freely; only the states are the host's business,
 * and those merge forward. Reading the persisted plan verbatim meant a host
 * onboarded before an agent type shipped had no step for it — and a *missing*
 * step reads as no objection, so the sidebar called that host ready for an
 * agent type it had never once looked for.
 *
 * Only writes when the set of steps actually changed, so the common case is a
 * plain read.
 */
export async function readAllSetupPlans(): Promise<HostSetupPlan[]> {
  const persisted = await listSetupPlans();
  const now = new Date().toISOString();
  const coreDependencies = CORE_DEPENDENCIES.map((dep) => ({ id: dep.id, name: dep.name }));
  const agentTypes = plannableAgentTypes();

  const plans: HostSetupPlan[] = [];
  for (const existing of persisted) {
    const rebuilt = buildSetupPlan({
      sshHost: existing.sshHost,
      coreDependencies,
      agentTypes,
      existing,
      now,
    });
    if (sameStepIds(existing, rebuilt)) {
      plans.push(existing);
      continue;
    }
    log.info('[HostSetup] plan gained or lost steps; persisting the new shape', {
      event: 'host-setup-plan-reshaped',
      sshHost: existing.sshHost,
      before: existing.steps.length,
      after: rebuilt.steps.length,
    });
    await saveSetupPlan(rebuilt);
    events.emit(hostSetupPlanEventChannel, rebuilt);
    plans.push(rebuilt);
  }
  return plans;
}

function sameStepIds(a: HostSetupPlan, b: HostSetupPlan): boolean {
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => step.id === b.steps[index]!.id);
}

/** The persisted plan, without rebuilding it. Null when the host has never run setup. */
export async function readSetupPlan(sshHost: string): Promise<HostSetupPlan | null> {
  return await getSetupPlan(sshHost);
}

function stepAgentId(step: HostSetupStep): string {
  return step.kind === 'agent-plugin' ? step.id.replace(/:plugin$/, '') : step.id;
}

function runnerFor(sshHost: string, manager: HostDependencyManager): HostSetupRunner {
  const existing = runners.get(sshHost);
  if (existing) return existing;

  const runner = new HostSetupRunner({
    sshHost,
    load: (host) => getSetupPlan(host),
    save: (plan) => saveSetupPlan(plan),
    publish: (plan) => events.emit(hostSetupPlanEventChannel, plan),
    requireReachable: (host) => hostReachabilityService.requireReachable(host),
    canInstall: (step) => {
      // The gh device flow is interactive by nature — it needs a terminal the
      // user types into, so it can never be part of an unattended run.
      if (step.kind === 'gh-auth') return false;
      if (step.kind === 'agent-plugin') return true;
      return manager.getInstallOptions(step.id).length > 0;
    },
    check: (step) => checkStep(sshHost, manager, step),
    install: (step) => installStep(sshHost, manager, step),
    update: (step) => updateStep(sshHost, manager, step),
  });

  runners.set(sshHost, runner);
  return runner;
}

/**
 * Observe one step, whatever kind it is.
 *
 * Exported so the rule that checking one row touches one agent type — and no
 * others — can be tested directly; it is not obvious from the call site, and
 * getting it wrong is silent apart from stray failures against an unrelated
 * row's CLI.
 */
export async function checkStep(
  sshHost: string,
  manager: HostDependencyManager,
  step: HostSetupStep
): Promise<StepCheckResult> {
  if (step.kind === 'gh-auth') {
    return outcomeForGhAuth(await probeGhAuthStatus(sshHost));
  }

  if (step.kind === 'agent-plugin') {
    const service = await getRemoteSwitchSetupService(sshHost);
    const agentId = stepAgentId(step);
    // Ask about this agent type alone. Listing every type's status and then
    // discarding all but one ran each other type's CLI over SSH as a side
    // effect, so checking one row reported failures for a different row's
    // absent CLI — and cost two extra round trips per type to do it.
    //
    // `checkForUpdates` rather than `getStatus`: it refreshes the host's
    // marketplace catalog first. `getStatus` reads whatever that host last
    // fetched, which can be arbitrarily old, so an update could exist and go
    // unreported indefinitely. A failed refresh does not throw — it returns the
    // cached versions with `refreshError` set, and an update we could not
    // confirm is simply not claimed.
    const status = await service.checkForUpdates(agentId);
    if (!status.supported) {
      return {
        outcome: 'unknown',
        error: `${agentId} is no longer a known agent type on this host.`,
      };
    }
    return status.installed
      ? {
          outcome: 'satisfied',
          version: status.installedVersion ?? null,
          latestVersion: status.latestVersion,
          updateAvailable: status.updateAvailable,
        }
      : // Nothing installed, so there is nothing to be out of date. What the
        // marketplace advertises is install-time detail, not an update.
        { outcome: 'missing' };
  }

  const state = await manager.probe(step.id);
  const result = outcomeForDependency(
    state,
    Boolean(remoteDependencyDescriptor(step.id)?.minVersion)
  );

  // Latest-version data is host-agnostic — it comes from the release source,
  // not the machine — so the same coordinator that answers for local agents
  // answers here, given this host's own installed version. No extra SSH.
  const update = agentUpdateService.getUpdateInfo(step.id as DependencyId, result.version ?? null);

  // A newer version existing is not the same as Switch Console being able to
  // install it. Whether an installation can be driven at all depends on how it
  // got there: `installationCanUpdate` says no for one whose provenance we
  // could not confirm, because the update would run some package manager's
  // command against files it does not own. The agents page has always applied
  // that gate; this path compared versions and skipped it, so a host page could
  // offer Update over an installation the manager then refuses outright with
  // `no-update-strategy` — or, on a root-owned npm prefix, with EACCES. Either
  // way the row bounced straight back to "Update available", which reads as the
  // page being confused rather than the update being impossible.
  const hostDependency = manager.getHostDependency(step.id as DependencyId);
  const active = hostDependency
    ? (agentUpdateService
        .enrichHostDependency(step.id as DependencyId, hostDependency)
        .installations.find((installation) => installation.isActive) ?? null)
    : null;

  return {
    ...result,
    latestVersion: update.latestVersion,
    // Host detail is built asynchronously after the probe, so the very first
    // check of a dependency may not have it yet. Withhold the claim rather than
    // guess: the next check has it, and under-reporting an update is a great
    // deal cheaper than offering one that cannot be carried out.
    updateAvailable: active?.updateAvailable ?? false,
  };
}

/**
 * Sampling interval for the progress line. Fast enough to read as live, slow
 * enough that a repainting progress bar does not turn into an IPC flood.
 */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Publish what a step's command is doing, for as long as it is running.
 *
 * Returns the stop function, which also clears the line: once the command is
 * over, what happened belongs to the step itself (satisfied, or failed with its
 * error and transcript) and a stale half-finished line beside it would only
 * contradict that.
 */
function streamInstallProgress(sshHost: string, stepId: string): () => void {
  const reader = new InstallProgressReader();
  const unsubscribe = installOutput.subscribe((event) => {
    if (event.sshHost === sshHost) reader.push(event.chunk);
  });
  const timer = setInterval(() => {
    const line = reader.take();
    if (line) events.emit(hostSetupActivityEventChannel, { sshHost, stepId, line });
  }, PROGRESS_INTERVAL_MS);

  return () => {
    unsubscribe();
    clearInterval(timer);
    events.emit(hostSetupActivityEventChannel, { sshHost, stepId, line: null });
  };
}

async function installStep(
  sshHost: string,
  manager: HostDependencyManager,
  step: HostSetupStep
): Promise<StepInstallResult> {
  if (step.kind === 'agent-plugin') {
    const service = await getRemoteSwitchSetupService(sshHost);
    const result = await service.install(stepAgentId(step));
    return result.success
      ? { ok: true }
      : { ok: false, error: result.message ?? `Could not install the Switch connector.` };
  }

  const stopProgress = streamInstallProgress(sshHost, step.id);
  let result: Awaited<ReturnType<typeof manager.install>>;
  try {
    result = await manager.install(step.id);
  } finally {
    stopProgress();
  }
  if (result.success) return { ok: true };

  // Surface the installer's own words. The old page discarded these and
  // rendered a bare "Install failed" — or, for a Result-typed failure, nothing.
  // Its words are not always intelligible, though, so the few failures we can
  // recognise are named plainly and the raw transcript is kept underneath.
  const error = result.error as { message?: string; output?: string; type?: string };
  const message = error.message ?? error.type ?? 'Install failed.';
  const output = error.output ? condenseCommandOutput(error.output) : null;
  return {
    ok: false,
    error: describeInstallFailure(step.name, message, output),
    output,
  };
}

/**
 * Replace one step with the newest available version.
 *
 * Exported for the same reason `checkStep` is: the routing (connector vs
 * dependency manager) is invisible from the call site and each half has its own
 * failure vocabulary.
 */
export async function updateStep(
  sshHost: string,
  manager: HostDependencyManager,
  step: HostSetupStep
): Promise<StepInstallResult> {
  if (step.kind === 'gh-auth') {
    return { ok: false, error: 'A GitHub login is not something that can be updated.' };
  }

  if (step.kind === 'agent-plugin') {
    const service = await getRemoteSwitchSetupService(sshHost);
    const result = await service.update(stepAgentId(step));
    return result.success
      ? { ok: true }
      : { ok: false, error: result.message ?? 'Could not update the Switch connector.' };
  }

  const stopProgress = streamInstallProgress(sshHost, step.id);
  let result: Awaited<ReturnType<typeof manager.update>>;
  try {
    result = await manager.update(step.id);
  } finally {
    stopProgress();
  }
  if (result.success) return { ok: true };

  const error = result.error as { message?: string; output?: string; type?: string };
  const message = error.message ?? error.type ?? 'Update failed.';
  const output = error.output ? condenseCommandOutput(error.output) : null;
  return { ok: false, error: describeInstallFailure(step.name, message, output), output };
}

/**
 * Observe a host without changing it — the "Re-check" button.
 *
 * Rebuilds the plan first so newly-known dependencies are included, then probes
 * every step and installs nothing.
 */
export async function recheckSetup(sshHost: string): Promise<HostSetupPlan> {
  const plan = await ensureSetupPlan(sshHost);
  const manager = await getRemoteDependencyManager(sshHost);
  try {
    return await runnerFor(sshHost, manager).checkAll(plan);
  } catch (error) {
    log.warn('[HostSetup] re-check stopped', {
      event: 'host-setup-recheck-stopped',
      sshHost,
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }
}

/**
 * Install one step on its own — the per-item Install button. Checks, installs,
 * and re-verifies just that step, leaving the rest of the plan alone.
 */
/** Re-observe a single step, installing nothing — the per-row re-check. */
export async function recheckSetupStep(sshHost: string, stepId: string): Promise<HostSetupPlan> {
  const plan = await ensureSetupPlan(sshHost);
  const manager = await getRemoteDependencyManager(sshHost);
  try {
    return await runnerFor(sshHost, manager).checkStep(plan, stepId);
  } catch (error) {
    log.warn('[HostSetup] step re-check stopped', {
      event: 'host-setup-step-recheck-stopped',
      sshHost,
      stepId,
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }
}

export async function installSetupStep(sshHost: string, stepId: string): Promise<HostSetupPlan> {
  const plan = await ensureSetupPlan(sshHost);
  const manager = await getRemoteDependencyManager(sshHost);
  try {
    return await runnerFor(sshHost, manager).runSingleStep(plan, stepId);
  } catch (error) {
    log.warn('[HostSetup] step install stopped', {
      event: 'host-setup-step-install-stopped',
      sshHost,
      stepId,
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }
}

/** Update one step to the newest available version — the per-row Update button. */
export async function updateSetupStep(sshHost: string, stepId: string): Promise<HostSetupPlan> {
  const plan = await ensureSetupPlan(sshHost);
  const manager = await getRemoteDependencyManager(sshHost);
  try {
    return await runnerFor(sshHost, manager).updateStep(plan, stepId);
  } catch (error) {
    log.warn('[HostSetup] step update stopped', {
      event: 'host-setup-step-update-stopped',
      sshHost,
      stepId,
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }
}

/** Move past a step the user has chosen not to fix, unblocking the rest. */
export async function skipSetupStep(sshHost: string, stepId: string): Promise<HostSetupPlan> {
  const plan = await getSetupPlan(sshHost);
  if (!plan) throw new Error(`No setup plan exists for ${sshHost}`);
  const manager = await getRemoteDependencyManager(sshHost);
  return await runnerFor(sshHost, manager).skip(plan, stepId);
}

/** Drop a host's plan and its runner — called when the host is removed. */
export async function discardSetupPlan(sshHost: string): Promise<void> {
  runners.delete(sshHost);
  await deleteSetupPlan(sshHost);
}

export { agentPluginStepId, GH_AUTH_STEP_ID };

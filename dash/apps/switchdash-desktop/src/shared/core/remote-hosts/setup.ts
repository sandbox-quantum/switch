/**
 * Model of a remote host's setup run (CHOO-1809).
 *
 * Onboarding a host used to be a single boolean — a row existed, or it didn't —
 * with every prerequisite probed independently by whichever component happened
 * to render. There was no notion of *where a host got to*, so nothing could be
 * resumed, nothing could be ordered, and a failure halfway through left no
 * record beyond whatever the UI happened to be holding in memory.
 *
 * A setup plan is that missing object: an ordered list of steps, persisted per
 * host. It is the single answer to "what still needs to happen on this host,
 * and what went wrong last time we tried?".
 *
 * Nothing advances the plan on its own. Each step is installed when the user
 * asks for that step — there is no run-everything button, deliberately: the
 * ordering is guidance, not automation.
 */

import { defineEvent } from '@shared/lib/ipc/events';

/**
 * What a check actually observed. Deliberately richer than a boolean, because
 * the interesting failures are not "missing" (CHOO-1803):
 *
 * - `satisfied` — present, correct version, and usable.
 * - `missing` — not installed.
 * - `not-running` — installed but the daemon/service is not up (Docker being
 *   the motivating case: `docker` on PATH tells you nothing about dockerd).
 * - `wrong-version` — installed but below the minimum we require.
 * - `unknown` — **we could not determine this.** A first-class answer, never
 *   collapsed into satisfied. Reporting "fine" for something we failed to
 *   observe is the stale-green bug from CHOO-1780.
 */
export type DependencyCheckOutcome =
  | 'satisfied'
  | 'missing'
  | 'not-running'
  | 'wrong-version'
  | 'unknown';

/** Outcomes that mean the step's requirement is genuinely met. */
export function isSatisfiedOutcome(outcome: DependencyCheckOutcome | null): boolean {
  return outcome === 'satisfied';
}

/**
 * Whether an outcome is something installing could plausibly fix. `not-running`
 * is excluded on purpose — starting a daemon is not installing a package, and
 * silently running an installer over a stopped service would misreport the
 * cause.
 */
export function isInstallableOutcome(outcome: DependencyCheckOutcome | null): boolean {
  return outcome === 'missing' || outcome === 'wrong-version';
}

/**
 * Where a step sits in its own lifecycle. Each step owns its state — the whole
 * point of the rewrite is that step 3 failing says nothing about steps 1-2.
 *
 * - `pending` — not reached yet.
 * - `checking` — a probe is in flight.
 * - `installing` — an install is in flight.
 * - `updating` — a replacement of something already present is in flight.
 *   Distinct from `installing` because the thing is not absent: if the update
 *   fails, what was there before is (usually) still there. Collapsing the two
 *   would have the row say "Installing…" about software the host already has.
 * - `satisfied` — verified present after the last observation.
 * - `failed` — the check or install failed; carries `error` (and `output` when
 *   a command produced any). The run halts here.
 * - `skipped` — the user chose to move past it. Never rendered as satisfied.
 */
export type HostSetupStepState =
  | 'pending'
  | 'checking'
  | 'installing'
  | 'updating'
  | 'satisfied'
  | 'failed'
  | 'skipped';

/** What kind of thing a step manages, for rendering and for install routing. */
export type HostSetupStepKind = 'core-dependency' | 'agent-cli' | 'agent-plugin' | 'gh-auth';

export type HostSetupStep = {
  /** Stable within a plan. Dependency id for deps; `<agentId>:plugin` for plugins. */
  id: string;
  kind: HostSetupStepKind;
  /** Display name, resolved when the plan is built. */
  name: string;
  state: HostSetupStepState;
  /** The last thing we actually observed. Null until first checked. */
  outcome: DependencyCheckOutcome | null;
  /** Detected version, when the probe found one. */
  version: string | null;
  /**
   * Version available to install, when that could be determined.
   *
   * Null means *unknown*, not "none newer" — the two are different and only one
   * of them justifies telling someone they are up to date.
   */
  latestVersion: string | null;
  /**
   * True only when a newer version is known to exist. Never inferred from a
   * missing `latestVersion`: not knowing is not evidence of currency.
   *
   * Deliberately does not make a step unsatisfied. An out-of-date connector
   * still works, so an available update is information, not a blocker — a host
   * is not "setup required" because something on it could be newer.
   */
  updateAvailable: boolean;
  /** Why this step failed. Null unless `state === 'failed'`. */
  error: string | null;
  /** Raw command output from a failed install — the detail users need. */
  output: string | null;
  /**
   * An optional step does not block the run or the host's usability. `gh` is
   * the motivating case: it needs an interactive device-flow login that a user
   * may reasonably defer without the host being unusable.
   */
  optional: boolean;
  /** Steps that must be satisfied before this one is attempted. */
  dependsOn: string[];
  /** ISO timestamp of the last state change. */
  updatedAt: string;
};

/**
 * Plan-level status.
 *
 * - `idle` — something required is still outstanding.
 * - `complete` — every required step is satisfied or skipped.
 *
 * Deliberately not a lifecycle: with no automated run there is nothing to be
 * "running" or "halted". Work in flight lives on the individual step.
 */
export type HostSetupPlanStatus = 'idle' | 'complete';

export type HostSetupPlan = {
  sshHost: string;
  status: HostSetupPlanStatus;
  steps: HostSetupStep[];
  /** The step currently in flight, or the one that halted the run. */
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * True while a command is running against this step.
 *
 * Defined once because "is something happening here?" is asked from half a
 * dozen places — badges, tiles, buttons, the host verdict. Each used to spell
 * the state list out inline, so adding `updating` to the union would have left
 * most of them quietly treating an update in progress as idle.
 */
export function isStepInFlight(step: HostSetupStep): boolean {
  return step.state === 'checking' || step.state === 'installing' || step.state === 'updating';
}

/** True while any step is being checked, installed or updated. */
export function isPlanBusy(plan: HostSetupPlan): boolean {
  return plan.steps.some(isStepInFlight);
}

/** The step currently being worked on, if any. */
export function inFlightStep(plan: HostSetupPlan): HostSetupStep | null {
  return plan.steps.find(isStepInFlight) ?? null;
}

/** Required steps that are not yet satisfied — what stands between here and done. */
export function outstandingRequiredSteps(plan: HostSetupPlan): HostSetupStep[] {
  return plan.steps.filter((step) => !step.optional && step.state !== 'satisfied');
}

const AGENT_PLUGIN_STEP_SUFFIX = ':plugin';

/** Step id for an agent type's Switch connector plugin. */
export function agentPluginStepId(agentId: string): string {
  return `${agentId}${AGENT_PLUGIN_STEP_SUFFIX}`;
}

/**
 * Whether a step describes the host itself rather than one agent type.
 *
 * This split is the difference between "this machine cannot run agents" and
 * "this machine cannot run *Codex*". Collapsing the two is what made a host with
 * every prerequisite installed report "Setup required" because one agent CLI of
 * several was absent, and then refused to create an agent of a type that was
 * perfectly well installed.
 */
export function isHostLevelStep(step: HostSetupStep): boolean {
  return step.kind === 'core-dependency' || step.kind === 'gh-auth';
}

/** The agent type a step belongs to, or null when the step is host-level. */
export function agentIdForStep(step: HostSetupStep): string | null {
  if (step.kind === 'agent-cli') return step.id;
  if (step.kind === 'agent-plugin') {
    return step.id.endsWith(AGENT_PLUGIN_STEP_SUFFIX)
      ? step.id.slice(0, -AGENT_PLUGIN_STEP_SUFFIX.length)
      : step.id;
  }
  return null;
}

/** The host's own prerequisites — every agent type needs all of these. */
export function hostLevelSteps(plan: HostSetupPlan): HostSetupStep[] {
  return plan.steps.filter(isHostLevelStep);
}

/** One agent type's steps: its CLI and its Switch connector. */
export function agentTypeSteps(plan: HostSetupPlan, agentId: string): HostSetupStep[] {
  return plan.steps.filter((step) => agentIdForStep(step) === agentId);
}

/** Host prerequisites still outstanding — these block every agent type. */
export function outstandingRequiredHostSteps(plan: HostSetupPlan): HostSetupStep[] {
  return hostLevelSteps(plan).filter((step) => !step.optional && step.state !== 'satisfied');
}

/** One agent type's outstanding steps — these block only that type. */
export function outstandingRequiredAgentTypeSteps(
  plan: HostSetupPlan,
  agentId: string
): HostSetupStep[] {
  return agentTypeSteps(plan, agentId).filter(
    (step) => !step.optional && step.state !== 'satisfied'
  );
}

/**
 * What stands between this host and running an agent of `agentId`, in the order
 * the user must deal with it: the host's own prerequisites first, because until
 * they are met the agent type's steps cannot even be attempted.
 *
 * Mirrors the precedence in `deriveAgentTypeStatus` so a verdict and the reasons
 * given for it cannot disagree.
 */
export function outstandingRequiredStepsFor(
  plan: HostSetupPlan,
  agentId: string | null
): HostSetupStep[] {
  const host = outstandingRequiredHostSteps(plan);
  if (host.length > 0 || !agentId) return host;
  return outstandingRequiredAgentTypeSteps(plan, agentId);
}

/**
 * Whether the host is usable for running agents. Optional steps and skipped
 * steps do not count against it; a step we could not verify does.
 */
export function isPlanComplete(plan: HostSetupPlan): boolean {
  return outstandingRequiredSteps(plan).length === 0;
}

/** Pushed to the renderer on every plan transition, so the UI never polls. */
export const hostSetupPlanEventChannel = defineEvent<HostSetupPlan>('remote-hosts:setup-changed');

/**
 * What a step is doing right now, in the running command's own words.
 *
 * A remote install can take minutes — fetching packages, unpacking, running
 * post-install hooks — and a spinner labelled "Installing…" for all of it is
 * indistinguishable from a hang. This carries the line the host is currently
 * printing so the user can see it is moving, and roughly on what.
 *
 * Deliberately not part of the plan: it is a live view of work in progress, not
 * a fact about the host. It is never persisted, and `line: null` means the work
 * has finished — whatever it concluded is then in the step itself.
 */
export type HostSetupActivity = {
  sshHost: string;
  stepId: string;
  line: string | null;
};

export const hostSetupActivityEventChannel = defineEvent<HostSetupActivity>(
  'remote-hosts:setup-activity'
);

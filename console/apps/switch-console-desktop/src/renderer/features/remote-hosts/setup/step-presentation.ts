/**
 * How a setup step is rendered (CHOO-1809).
 *
 * Kept as pure functions rather than inline JSX conditionals so the rules that
 * matter can be tested directly — above all: **nothing that was not observed to
 * be present is ever shown as done**. The previous page decided tone with
 * chained ternaries over booleans, which is how "we didn't check" came to look
 * identical to "we checked and it's fine".
 */

import type { StatusTone } from '@renderer/lib/ui/status-badge';
import {
  agentPluginStepId,
  hostLevelSteps,
  type DependencyCheckOutcome,
  type HostSetupPlan,
  type HostSetupStep,
} from '@shared/core/remote-hosts/setup';

/**
 * What a check observed, in words. `unknown` says so plainly rather than
 * borrowing the language of a definite answer.
 */
export function outcomeLabel(outcome: DependencyCheckOutcome | null): string {
  switch (outcome) {
    case 'satisfied':
      return 'Ready';
    case 'missing':
      return 'Not installed';
    case 'not-running':
      return 'Installed but not running';
    case 'wrong-version':
      return 'Installed but too old';
    case 'unknown':
      return 'Could not be checked';
    case null:
      return 'Not checked yet';
  }
}

/**
 * Steps the user can move past. A failure is the obvious case, but a step we
 * have observed to be missing is equally skippable — after a re-check nothing
 * has "failed" yet, and offering no way forward would strand the run.
 */
export function canSkip(step: HostSetupStep): boolean {
  if (step.state === 'failed') return true;
  return step.state === 'pending' && step.outcome !== null && step.outcome !== 'satisfied';
}

/**
 * Whether Switch Console can attempt an install for this step.
 *
 * The GitHub login is excluded because it is an interactive device flow, not an
 * install. Whether an install command actually exists for this host's platform
 * is known only in the main process — if it does not, the attempt reports that
 * plainly rather than the button being silently absent.
 */
export function canInstall(step: HostSetupStep): boolean {
  if (step.kind === 'gh-auth') return false;
  if (
    step.state === 'satisfied' ||
    step.state === 'checking' ||
    step.state === 'installing' ||
    step.state === 'updating'
  ) {
    return false;
  }
  return true;
}

/**
 * Whether to offer an update for this step.
 *
 * Gated on `updateAvailable` alone, which is only ever true when a newer
 * version is *known* to exist — never inferred from a version we could not
 * read. A login has no version to replace, and something not yet installed
 * needs Install rather than Update.
 */
export function canUpdate(step: HostSetupStep): boolean {
  if (step.kind === 'gh-auth') return false;
  if (step.state !== 'satisfied') return false;
  return step.updateAvailable;
}

/**
 * Whether everything this step declares a dependency on has been satisfied.
 *
 * The GitHub login is the case that matters: its device flow runs `gh` on the
 * host, so offering it before `gh` exists sends the user into a failure that
 * says nothing about the real problem.
 */
export function dependenciesMet(step: HostSetupStep, plan: HostSetupPlan | null): boolean {
  if (step.dependsOn.length === 0) return true;
  if (!plan) return false;
  return step.dependsOn.every(
    (id) => plan.steps.find((candidate) => candidate.id === id)?.state === 'satisfied'
  );
}

/**
 * Whether to offer the GitHub sign-in for this step.
 *
 * Only once `gh` itself is installed: the device flow runs `gh` on the host, so
 * offering it earlier sends the user into a failure that says nothing about the
 * real problem.
 */
export function canSignIn(step: HostSetupStep, plan: HostSetupPlan | null): boolean {
  if (step.kind !== 'gh-auth') return false;
  // Same in-flight exclusion `canInstall` makes. A check moves the step through
  // `checking` on its way back to a verdict, and "not yet satisfied" during
  // that window is not the same fact as "signed out" — without this, re-checking
  // a working login flashes a Sign in button at someone already signed in.
  if (step.state === 'satisfied' || step.state === 'checking' || step.state === 'installing') {
    return false;
  }
  return dependenciesMet(step, plan);
}

/**
 * Whether a row may offer its fix-it action right now.
 *
 * Not while the host is busy. The runner takes one operation per host at a time
 * and refuses the rest, so an Install offered during a check is an offer that
 * cannot be honoured — clicking it raises "another setup operation is already
 * running", which reads as this dependency's fault rather than as the button
 * never having been live.
 *
 * The single exception is the row whose own install is the operation in flight:
 * there the button is the progress indicator.
 */
export function canOfferAction(hostBusy: boolean, isInstallingThisRow: boolean): boolean {
  return !hostBusy || isInstallingThisRow;
}

/**
 * A login that exists but lacks a scope is not signed out, and telling someone
 * already signed in to "sign in" reads as wrong advice — even though re-running
 * the flow is in fact the fix.
 */
export function signInLabel(step: HostSetupStep): string {
  return step.error?.includes('read:packages') ? 'Re-authenticate' : 'Sign in';
}

/**
 * The version line under a row's name.
 *
 * When something newer exists, both numbers are shown — `0.146.0 → 0.147.0`.
 * The badge can only say *that* an update exists; what you usually want to know
 * before taking one is how far behind you are, and hiding that in the Update
 * button's tooltip made it invisible to anyone not already hovering it.
 *
 * Only for a satisfied step: a version on a row that is not installed would be
 * describing something that is not there.
 */
export function versionSubtitle(step: HostSetupStep): string | null {
  if (step.state !== 'satisfied') return null;
  if (!step.updateAvailable || !step.latestVersion) return step.version;
  // `updateAvailable` is only ever true off a real comparison, so a missing
  // installed version here would be a contradiction — say what we do know.
  return step.version ? `${step.version} → ${step.latestVersion}` : `→ ${step.latestVersion}`;
}

export type BadgeSpec = { tone: StatusTone; label: string };

/**
 * The pill shown on a step row.
 *
 * `satisfied` is the only state that earns green, and `pending` says "not
 * checked" rather than borrowing the language of a negative result — we have
 * not looked, which is not the same as having looked and found nothing.
 */
export function stepBadge(step: HostSetupStep): BadgeSpec {
  switch (step.state) {
    case 'satisfied':
      // An available update does not make a step unsatisfied — what is
      // installed still works — but it is the one thing about a healthy row
      // worth surfacing, so it takes the badge.
      //
      // Note the absence of an "Up to date" badge. `updateAvailable: false`
      // means either "nothing newer" or "we could not tell", and only one of
      // those earns the claim; "Installed" is true in both cases.
      return step.updateAvailable
        ? { tone: 'warning', label: 'Update available' }
        : { tone: 'success', label: 'Installed' };
    case 'checking':
      return { tone: 'info', label: 'Checking…' };
    case 'installing':
      return { tone: 'info', label: 'Installing…' };
    case 'updating':
      return { tone: 'info', label: 'Updating…' };
    case 'failed':
      // The label normally names the last observation, which for a failed
      // install is the useful thing to say ("Not installed"). It must not be
      // said when that observation was `satisfied`: a failed action over
      // something that is present rendered a red badge reading "Ready", which
      // is two contradictions in three words.
      return step.outcome === 'satisfied'
        ? { tone: 'danger', label: 'Last action failed' }
        : { tone: 'danger', label: outcomeLabel(step.outcome) };
    case 'skipped':
      return { tone: 'neutral', label: 'Skipped' };
    case 'pending':
      // A re-check leaves steps pending but records what it saw. "Not checked"
      // and "checked, and it isn't there" are different facts and must not
      // share a label.
      return step.outcome === null
        ? { tone: 'neutral', label: 'Not checked' }
        : { tone: 'warning', label: outcomeLabel(step.outcome) };
  }
}

/**
 * An agent type as one row: its CLI and its Switch connector are two steps, but
 * a user thinks of them as one thing being usable or not. Mirrors how the
 * agents settings page presents a local agent.
 */
export type AgentTypeRow = {
  agentId: string;
  name: string;
  cli: HostSetupStep;
  /** Null only if the plan predates connector steps. */
  plugin: HostSetupStep | null;
};

/**
 * Combined status for an agent type.
 *
 * An installed CLI is not usable on its own — without the Switch connector the
 * agent starts and has no Switch tools. That intermediate state gets its own
 * label rather than being rounded up to "installed".
 */
export function agentTypeBadge(row: AgentTypeRow): BadgeSpec {
  const inFlight = [row.cli, row.plugin].find(
    (step) =>
      step?.state === 'checking' || step?.state === 'installing' || step?.state === 'updating'
  );
  if (inFlight) return stepBadge(inFlight);

  const failed = [row.cli, row.plugin].find((step) => step?.state === 'failed');
  if (failed) return { tone: 'danger', label: outcomeLabel(failed.outcome) };

  if (row.cli.state !== 'satisfied') return stepBadge(row.cli);
  if (row.plugin && row.plugin.state !== 'satisfied') {
    return { tone: 'warning', label: 'Switch setup required' };
  }
  // Either half being out of date is worth saying, and the row states one
  // question — is this usable, and is it current?
  if (row.cli.updateAvailable || row.plugin?.updateAvailable) {
    return { tone: 'warning', label: 'Update available' };
  }
  return { tone: 'success', label: 'Installed' };
}

export type GroupedPlan = {
  /** Host tools and the GitHub login — everything an agent needs before itself. */
  prerequisites: HostSetupStep[];
  agentTypes: AgentTypeRow[];
};

/** Split a plan into the two things a host page is actually about. */
export function groupPlanSteps(plan: HostSetupPlan | null): GroupedPlan {
  if (!plan) return { prerequisites: [], agentTypes: [] };

  // Same partition the host verdict uses, so the section a step is listed under
  // cannot disagree with the badge that judges it.
  const prerequisites = hostLevelSteps(plan);

  const agentTypes = plan.steps
    .filter((step) => step.kind === 'agent-cli')
    .map((cli) => ({
      agentId: cli.id,
      name: cli.name,
      cli,
      plugin:
        plan.steps.find((s) => s.kind === 'agent-plugin' && s.id === agentPluginStepId(cli.id)) ??
        null,
    }));

  return { prerequisites, agentTypes };
}

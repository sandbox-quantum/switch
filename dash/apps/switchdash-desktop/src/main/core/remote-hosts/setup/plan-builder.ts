/**
 * Builds a host's ordered setup plan (CHOO-1809).
 *
 * The order is the point. Onboarding used to present every prerequisite at once
 * and leave the user to infer the sequence — which mattered, because the agent
 * CLIs are installed with npm and therefore need Node first. Here the order is
 * declared once, in one place:
 *
 *   1. core host tools, in dependency order (git → node → tmux → …)
 *   2. gh, then its interactive login
 *   3. per agent type: its CLI, then the Switch connector plugin
 *
 * Rebuilding is **merge, not replace**. A plan is rebuilt whenever the set of
 * known dependencies changes (a new agent type ships, say), and discarding the
 * existing states would silently undo work the user already did. Steps that
 * survive a rebuild keep their state; steps that disappear are dropped.
 */

import {
  agentPluginStepId,
  isStepInFlight,
  type HostSetupPlan,
  type HostSetupStep,
  type HostSetupStepKind,
} from '@shared/core/remote-hosts/setup';

export { agentPluginStepId };

/** A dependency switchdash knows how to check on the host. */
export type PlannableDependency = {
  id: string;
  name: string;
};

/** An agent type that can run under Switch, and therefore needs CLI + plugin. */
export type PlannableAgentType = {
  agentId: string;
  name: string;
};

export type BuildPlanInput = {
  sshHost: string;
  /** Core host tools, already in the order they should be installed. */
  coreDependencies: PlannableDependency[];
  /** Agent types worth offering — only those the Switch plugin supports. */
  agentTypes: PlannableAgentType[];
  /** Existing plan to merge onto, when one has been persisted. */
  existing: HostSetupPlan | null;
  now: string;
};

/** Step id for the interactive `gh auth login`. */
export const GH_AUTH_STEP_ID = 'gh:auth';

function blankStep(
  id: string,
  kind: HostSetupStepKind,
  name: string,
  now: string,
  options: { optional?: boolean; dependsOn?: string[] } = {}
): HostSetupStep {
  return {
    id,
    kind,
    name,
    state: 'pending',
    outcome: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: options.optional ?? false,
    dependsOn: options.dependsOn ?? [],
    updatedAt: now,
  };
}

export function buildSetupPlan(input: BuildPlanInput): HostSetupPlan {
  const { sshHost, coreDependencies, agentTypes, existing, now } = input;
  const steps: HostSetupStep[] = [];

  for (const dep of coreDependencies) {
    // gh was optional on the theory that its interactive login could be
    // deferred without the host being unusable. CHOO-1873 disproved that: the
    // Switch connector fetches its MCP runtime from GitHub Packages at session
    // start, so without gh — authenticated, with read:packages — every agent on
    // this host comes up with no Switch tools. A host in that state is not
    // ready, and calling it ready is the failure this rewrite exists to remove.
    steps.push(blankStep(dep.id, 'core-dependency', dep.name, now));

    if (dep.id === 'gh') {
      steps.push(
        blankStep(GH_AUTH_STEP_ID, 'gh-auth', 'GitHub CLI login', now, {
          dependsOn: ['gh'],
        })
      );
    }
  }

  for (const agent of agentTypes) {
    steps.push(
      blankStep(agent.agentId, 'agent-cli', agent.name, now, {
        // The CLIs install via npm, so Node has to be in place first. Declared
        // rather than implied by list position.
        dependsOn: coreDependencies.some((d) => d.id === 'node') ? ['node'] : [],
      })
    );
    steps.push(
      blankStep(
        agentPluginStepId(agent.agentId),
        'agent-plugin',
        `${agent.name} · Switch connector`,
        now,
        { dependsOn: [agent.agentId] }
      )
    );
  }

  return {
    sshHost,
    status: existing?.status ?? 'idle',
    steps: existing ? mergeSteps(steps, existing.steps) : steps,
    currentStepId: existing?.currentStepId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Carry prior progress onto a freshly built plan. The new plan defines which
 * steps exist and in what order; the old one contributes what we already know
 * about the steps that still exist.
 */
function mergeSteps(fresh: HostSetupStep[], previous: HostSetupStep[]): HostSetupStep[] {
  const byId = new Map(previous.map((step) => [step.id, step]));
  return fresh.map((step) => {
    const prior = byId.get(step.id);
    if (!prior) return step;
    return {
      ...step,
      state: prior.state,
      outcome: prior.outcome,
      version: prior.version,
      latestVersion: prior.latestVersion,
      updateAvailable: prior.updateAvailable,
      error: prior.error,
      output: prior.output,
      updatedAt: prior.updatedAt,
    };
  });
}

/**
 * Reset a plan's transient states so the next look re-observes rather than
 * trusting what a previous process was mid-way through. Anything left in flight
 * when the app died is of unknown truth — the one thing it must not become is
 * `satisfied`.
 */
export function reconcileInterruptedPlan(plan: HostSetupPlan, now: string): HostSetupPlan {
  const interrupted = plan.steps.some(isStepInFlight);
  if (!interrupted) return plan;

  return {
    ...plan,
    steps: plan.steps.map((step) =>
      isStepInFlight(step)
        ? {
            ...step,
            state: 'pending',
            outcome: null,
            error: null,
            updatedAt: now,
          }
        : step
    ),
  };
}

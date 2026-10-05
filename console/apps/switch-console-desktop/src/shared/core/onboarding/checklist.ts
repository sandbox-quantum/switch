import type { CloudProviderConnection } from '@shared/core/switch-servers/provider-credential';

/**
 * Model of the first-run onboarding checklist (CHOO-2022).
 *
 * A new install is functional but unexplained: every piece of setup exists as
 * its own dialog, reachable from somewhere, in an order nobody states. The
 * checklist names that order and says where you are in it.
 *
 * Completion is **derived from what the app can actually see** — a server is
 * registered, a provider is signed in, an agent is onboarded, a room exists —
 * and never from "the user clicked this once". A remembered click would keep
 * claiming a step was done after the thing it produced was deleted, which is
 * exactly the stale-green lie the rest of this app avoids.
 *
 * Because progress is observed rather than recorded, steps can complete out of
 * order: a user already signed in to Claude Code satisfies the provider step
 * before adding a server. The ordering is guidance, not a gate.
 */

export const ONBOARDING_STEP_IDS = [
  'addServer',
  'agentProviders',
  'onboardAgents',
  'createRoom',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Whether each step's requirement is currently met. */
export type OnboardingProgress = Record<OnboardingStepId, boolean>;

/**
 * How a step reads in the list:
 *
 * - `done` — its requirement is met.
 * - `active` — the first unmet step: the one thing to do next.
 * - `upcoming` — unmet, but not next. Rendered muted so the list reads as a
 *   sequence rather than four equal demands.
 */
export type OnboardingStepStatus = 'done' | 'active' | 'upcoming';

export type OnboardingStep = {
  id: OnboardingStepId;
  label: string;
  status: OnboardingStepStatus;
};

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  addServer: 'Add a server',
  agentProviders: 'Set up agent providers',
  onboardAgents: 'Onboard your agents',
  createRoom: 'Create a room',
};

/** No progress at all — the state a fresh install starts in. */
export const EMPTY_ONBOARDING_PROGRESS: OnboardingProgress = {
  addServer: false,
  agentProviders: false,
  onboardAgents: false,
  createRoom: false,
};

/**
 * The list as rendered: every step in fixed order, each labelled and given a
 * status. Exactly one step is `active` unless everything is done, in which case
 * none is.
 */
export function deriveOnboardingSteps(progress: OnboardingProgress): OnboardingStep[] {
  const firstUnmet = ONBOARDING_STEP_IDS.find((id) => !progress[id]);
  return ONBOARDING_STEP_IDS.map((id) => ({
    id,
    label: ONBOARDING_STEP_LABELS[id],
    status: progress[id] ? 'done' : id === firstUnmet ? 'active' : 'upcoming',
  }));
}

/** Whether every step's requirement is met, which is what shows "All set!". */
export function isOnboardingComplete(progress: OnboardingProgress): boolean {
  return ONBOARDING_STEP_IDS.every((id) => progress[id]);
}

/** How many steps are done, for the collapsed header's progress read-out. */
export function countCompletedSteps(progress: OnboardingProgress): number {
  return ONBOARDING_STEP_IDS.filter((id) => progress[id]).length;
}

/** What a provider's readiness check answered for one machine. */
export type ProviderReadinessAnswer = { installed: boolean | null; status: string };

/**
 * Whether any agent provider is set up to run an agent: signed in on this
 * computer, or holding a credential on Switch Cloud. An installed CLI nobody
 * has signed in to does not count, nor does a cloud credential still being
 * checked or one that failed its check. An answer not yet in reads as not set up.
 */
export function anyProviderConnected(
  local: readonly (ProviderReadinessAnswer | undefined)[],
  cloud: readonly (CloudProviderConnection | undefined)[]
): boolean {
  return (
    local.some((answer) => answer?.installed === true && answer.status === 'authenticated') ||
    cloud.some((answer) => answer?.status === 'connected' || answer?.status === 'configured')
  );
}

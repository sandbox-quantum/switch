/**
 * The agent-creation readiness gate's decision (CHOO-1809).
 *
 * Split from the component so the rule can be tested without dragging in the
 * renderer's electron bridge — and because this rule is the whole point of the
 * gate, not an implementation detail of a notice.
 */

import type { HostStatus } from '@shared/core/remote-hosts/host-status';
import {
  agentTypeSteps,
  hostLevelSteps,
  outstandingRequiredHostSteps,
  outstandingRequiredStepsFor,
  type HostSetupPlan,
} from '@shared/core/remote-hosts/setup';

/**
 * Whether the block is the machine or just the agent type asked for.
 *
 * The two lead to different places: a host-level block stops every agent and is
 * fixed on the host page, while an agent-type block can also be sidestepped by
 * choosing a type the host already has.
 */
export type ReadinessScope = 'host' | 'agent-type';

export type HostReadiness = {
  /** True when we know the host is missing something the chosen agent needs. */
  blocked: boolean;
  /** True while a probe is in flight — not a verdict, just "ask again shortly". */
  checking: boolean;
  /** Required steps not yet satisfied. Empty unless `blocked`. */
  missing: string[];
  /** What the block is about. Null unless `blocked`. */
  scope: ReadinessScope | null;
};

const READY: HostReadiness = { blocked: false, checking: false, missing: [], scope: null };

/**
 * How long an observation is trusted before it is worth looking again.
 *
 * A host's dependencies do not change on their own, so re-probing on every
 * glance buys nothing and costs an SSH round trip per step. Ten minutes is long
 * enough that opening the modal repeatedly is free, and short enough that
 * something installed by hand shows up without the user hunting for a re-check.
 */
export const OBSERVATION_TTL_MS = 10 * 60_000;

/**
 * Which steps are worth re-observing before judging this agent type.
 *
 * Empty means the persisted plan is good enough to answer from — which is the
 * common case, and the whole point of persisting it.
 *
 * Deliberately narrow: only the host's own prerequisites plus the one agent
 * type being created. Re-checking every type meant picking Codex probed git,
 * tmux, node and Claude Code as well, roughly thirty SSH commands to answer a
 * question about one of them.
 */
export function stepsNeedingObservation(
  plan: HostSetupPlan | null,
  agentId: string | null,
  now: number,
  ttlMs: number = OBSERVATION_TTL_MS
): string[] {
  if (!plan) return [];
  const relevant = [...hostLevelSteps(plan), ...(agentId ? agentTypeSteps(plan, agentId) : [])];
  return relevant
    .filter((step) => {
      // Never observed at all: nothing to go stale, everything to find out.
      if (step.outcome === null) return true;
      const seenAt = Date.parse(step.updatedAt);
      // An unparseable timestamp is not evidence of freshness.
      if (Number.isNaN(seenAt)) return true;
      return now - seenAt > ttlMs;
    })
    .map((step) => step.id);
}

/**
 * The gate's decision, as a pure function.
 *
 * `status` is the agent-type-aware verdict, so passing the status for the type
 * being created is what makes this gate answer "is this host ready for *this*
 * agent?" rather than "is it ready for every type it could ever run?" — the
 * question it used to ask, which let a missing Codex block creating a Claude
 * Code agent.
 *
 * `probing` withholds a verdict rather than being one: while we are looking, the
 * honest answer is "ask again shortly", not "no". And a host we could not
 * determine anything about is NOT blocked — refusing on ignorance is the same
 * mistake as the false green, inverted.
 */
export function resolveReadiness(
  status: HostStatus | null,
  plan: HostSetupPlan | null,
  agentId: string | null,
  probing: boolean
): HostReadiness {
  if (!status) return READY;
  if (probing) return { blocked: false, checking: true, missing: [], scope: null };

  // A chosen agent type with no steps in the plan is one nobody has looked for.
  // `deriveAgentTypeStatus` falls back to the host's verdict there, which is
  // correct when describing the *host* and wrong as permission to create: it
  // means this type's CLI and connector were never checked. An agent whose
  // connector is absent starts with no Switch tools at all, which is the
  // failure this gate exists to prevent — and "we never looked" is not evidence
  // against it happening.
  if (status.kind === 'ready' && agentId && plan && agentTypeSteps(plan, agentId).length === 0) {
    return { blocked: true, checking: false, missing: [], scope: 'agent-type' };
  }

  if (status.kind !== 'setup-required') return READY;
  if (!plan) return { blocked: true, checking: false, missing: [], scope: 'host' };

  const hostOutstanding = outstandingRequiredHostSteps(plan);
  return {
    blocked: true,
    checking: false,
    missing: outstandingRequiredStepsFor(plan, agentId).map((step) => step.name),
    scope: hostOutstanding.length > 0 ? 'host' : 'agent-type',
  };
}

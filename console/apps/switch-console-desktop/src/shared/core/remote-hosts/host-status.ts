/**
 * A remote host's status, as one value (CHOO-1809).
 *
 * There is no "host" object in the app: an agent points at a location, a
 * location carries an SSH alias, and three separate stores are keyed by that
 * alias — the host row, its reachability, and its setup plan. Nothing could
 * answer "how is this host doing?" in one place, so every screen answered it
 * again and slightly differently.
 *
 * This is that answer, derived once and read everywhere.
 *
 * Two ordering rules matter here:
 *
 * 1. **Readiness is conditional on reachability.** A host we cannot reach
 *    reports *unreachable* with its readiness withheld — never "not ready",
 *    which would blame the prerequisites for a network problem (the conflation
 *    CHOO-1780 removed).
 * 2. **The host and its agent types are separate verdicts.** `deriveHostStatus`
 *    answers "can this machine run agents at all?" from its prerequisites
 *    alone; `deriveAgentTypeStatus` answers "can it run *this* type?". A host
 *    with every prerequisite installed is ready even if one of several agent
 *    CLIs is absent — that absence blocks its own type, nothing else.
 */

import { isHostBlocked, type HostReachability } from './reachability';
import {
  agentTypeSteps,
  hostLevelSteps,
  isStepInFlight,
  type HostSetupPlan,
  type HostSetupStep,
} from './setup';

export type HostStatusKind =
  /** SSH authentication failed — will not self-heal, the user must fix it. */
  | 'auth-failed'
  /** We cannot reach the host, so we cannot say anything about readiness. */
  | 'unreachable'
  /** Reachable, but nothing has ever been observed about it. */
  | 'unchecked'
  /** A check or install is in flight on one of its steps. */
  | 'setting-up'
  /** Reachable and every required step was observed satisfied. */
  | 'ready'
  /** Reachable, and something required is missing or failed. */
  | 'setup-required';

/** Same vocabulary as the renderer's StatusBadge tones, without importing it. */
export type HostStatusTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

export type HostStatus = {
  kind: HostStatusKind;
  /** Short label for a badge. */
  label: string;
  tone: HostStatusTone;
  /**
   * Whether readiness is actually known. False when the host is unreachable —
   * the setup state we hold may be stale and must not be presented as current.
   */
  readinessKnown: boolean;
  /**
   * Steps satisfied / total, counting everything in the group this verdict is
   * about — the host's prerequisites, or one agent type's steps.
   *
   * Deliberately not "required only": a count that silently excludes optional
   * steps cannot be reconciled with the list beside it, which is how a host
   * came to read "5 of 5 required" with two rows plainly saying *Not
   * installed*. The verdict below still turns on required steps alone.
   */
  done: number;
  total: number;
};

/**
 * Whether a host is usable for running agents *right now*.
 *
 * Deliberately not "is the plan complete": an unreachable host is not usable
 * however good its last setup run looked.
 */
export function isHostUsable(status: HostStatus): boolean {
  return status.kind === 'ready';
}

export function deriveHostStatus(
  reachability: HostReachability,
  plan: HostSetupPlan | null
): HostStatus {
  if (isHostBlocked(reachability)) {
    const authFailed = reachability.status === 'suspended';
    return {
      kind: authFailed ? 'auth-failed' : 'unreachable',
      label: authFailed ? 'SSH auth failed' : 'Unreachable',
      tone: 'danger',
      readinessKnown: false,
      done: 0,
      total: 0,
    };
  }

  if (!plan) return UNCHECKED;
  return deriveFromSteps(hostLevelSteps(plan));
}

/**
 * The same verdict, narrowed to "can this host run an agent of *this* type?".
 *
 * The host's own state comes first and dominates: a host missing git cannot run
 * anything, so every agent type inherits that verdict rather than each reporting
 * its own CLI as the problem. Only once the host itself is ready does the
 * question become type-specific.
 *
 * A type with no steps in the plan — one whose connector Switch Console does not
 * manage — is not held against the host: there is nothing type-specific to
 * satisfy, so the host's verdict stands.
 */
export function deriveAgentTypeStatus(
  reachability: HostReachability,
  plan: HostSetupPlan | null,
  agentId: string | null
): HostStatus {
  const host = deriveHostStatus(reachability, plan);
  if (host.kind !== 'ready' || !plan || !agentId) return host;

  const steps = agentTypeSteps(plan, agentId);
  if (steps.length === 0) return host;
  return deriveFromSteps(steps);
}

const UNCHECKED: HostStatus = {
  kind: 'unchecked',
  label: 'Not checked',
  tone: 'neutral',
  readinessKnown: false,
  done: 0,
  total: 0,
};

/**
 * The verdict for one group of steps, host-level or agent-type.
 *
 * Shared so the two cannot drift into judging the same evidence differently —
 * the only thing that varies between them is which steps they are handed.
 */
function deriveFromSteps(steps: HostSetupStep[]): HostStatus {
  if (steps.length === 0) return UNCHECKED;

  const total = steps.length;
  const done = steps.filter((step) => step.state === 'satisfied').length;

  // Work in flight lives on the step, not the plan: there is no automated run
  // to be "running", only whatever the user asked for a moment ago.
  const inFlight = steps.find(isStepInFlight);
  if (inFlight) {
    return {
      kind: 'setting-up',
      label: `Setting up ${inFlight.name}…`,
      tone: 'info',
      readinessKnown: true,
      done,
      total,
    };
  }

  if (steps.every((step) => step.optional || step.state === 'satisfied')) {
    return { kind: 'ready', label: 'Ready', tone: 'success', readinessKnown: true, done, total };
  }

  // Nothing observed yet is materially different from "we looked and it's
  // missing" — saying "setup required" of a host nobody has checked overstates
  // what we know.
  //
  // "Untouched" means both: no observation recorded (a re-check leaves steps
  // pending but stores what it saw) and no step moved off pending (skipping one
  // is a decision the user made, and reporting that host as unchecked would
  // hide it).
  const untouched = steps.every((step) => step.outcome === null && step.state === 'pending');
  if (untouched) {
    return {
      kind: 'unchecked',
      label: 'Not checked',
      tone: 'neutral',
      readinessKnown: false,
      done,
      total,
    };
  }

  return {
    kind: 'setup-required',
    label: 'Setup required',
    tone: 'warning',
    readinessKnown: true,
    done,
    total,
  };
}

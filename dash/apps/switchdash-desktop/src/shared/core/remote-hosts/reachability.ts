/**
 * First-class model of a remote SSH host's reachability (CHOO-1682).
 *
 * Before this, "can we reach host X?" was answered independently by every
 * consumer: the pooled SSH connection's in-memory state, an on-demand
 * `testConnection`, or simply attempting the work and interpreting the ssh2
 * error. That produced two failure modes — unbounded retry loops hammering a
 * dead host (the reconciler reconnecting every 2s per agent), and ad-hoc raw
 * transport errors surfacing in the UI with no shared notion of "this host is
 * down". Reachability is now one per-host state machine that every
 * host-dependent path consults up front.
 */

import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Where a host sits in the reachability state machine.
 *
 * - `unknown` — never probed this app run (and nothing persisted). Work is
 *   allowed through: the first attempt is what establishes reachability.
 * - `reachable` — a probe or live connection succeeded. Work proceeds.
 * - `unreachable` — probes are failing. Host-dependent background work pauses;
 *   a bounded backoff probe keeps checking so recovery is automatic.
 * - `suspended` — authentication failed. Retrying a rejected key never
 *   self-heals, so no automatic probing happens; the user must fix auth and
 *   retry explicitly.
 */
export type HostReachabilityStatus = 'unknown' | 'reachable' | 'unreachable' | 'suspended';

/** The full reachability record for one host alias. */
export type HostReachability = {
  /** The `~/.ssh/config` Host alias this record describes. */
  sshHost: string;
  status: HostReachabilityStatus;
  /** Message from the most recent failed probe; null while reachable. */
  lastError: string | null;
  /** ISO timestamp of the last probe (successful or not). */
  lastCheckedAt: string | null;
  /** ISO timestamp of the last time the host was confirmed reachable. */
  lastReachableAt: string | null;
  /** Consecutive failed probes — drives the backoff step. */
  consecutiveFailures: number;
  /** ISO timestamp of the next scheduled probe; null when none is scheduled. */
  nextProbeAt: string | null;
  /** True while a probe is in flight (for spinners; not a persisted state). */
  probing: boolean;
};

/**
 * Whether host-dependent work should be held back. `unknown` is deliberately
 * NOT blocked — a host we have never probed gets one real attempt rather than
 * being gated behind a probe that would duplicate it.
 */
export function isHostBlocked(reachability: HostReachability): boolean {
  return reachability.status === 'unreachable' || reachability.status === 'suspended';
}

/** Human-readable one-liner for the blocked state, used in errors and the UI. */
export function hostBlockedReason(reachability: HostReachability): string {
  const since = reachability.lastCheckedAt ? ` since ${reachability.lastCheckedAt}` : '';
  if (reachability.status === 'suspended') {
    return `SSH authentication to ${reachability.sshHost} failed${since}: ${
      reachability.lastError ?? 'unknown error'
    }. Fix the host's SSH credentials, then retry.`;
  }
  return `Host ${reachability.sshHost} is unreachable${since}: ${
    reachability.lastError ?? 'unknown error'
  }`;
}

/**
 * Raised when host-dependent work is attempted against a host known to be
 * unreachable. Carries the reachability record so callers (and the UI) can
 * render the modeled state rather than re-deriving it from a transport error.
 *
 * It lives with the model rather than with the service that throws it so that
 * anything holding an error — including the RPC logging chokepoint — can
 * recognise it without pulling in the service and its persistence.
 */
export class HostUnreachableError extends Error {
  readonly reachability: HostReachability;

  constructor(reachability: HostReachability) {
    super(hostBlockedReason(reachability));
    this.name = 'HostUnreachableError';
    this.reachability = reachability;
  }
}

export function unknownHostReachability(sshHost: string): HostReachability {
  return {
    sshHost,
    status: 'unknown',
    lastError: null,
    lastCheckedAt: null,
    lastReachableAt: null,
    consecutiveFailures: 0,
    nextProbeAt: null,
    probing: false,
  };
}

/** Pushed to the renderer whenever a host's reachability record changes. */
export const hostReachabilityEventChannel = defineEvent<HostReachability>(
  'remote-hosts:reachability-changed'
);

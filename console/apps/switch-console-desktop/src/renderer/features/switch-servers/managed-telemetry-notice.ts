import type { DeployedTelemetry } from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * What a managed server's page has to say about usage data (CHOO-2890).
 *
 * "Share usage data" is one decision covering Switch Console and the server it
 * runs, but the server only reads it when it starts. So the answer the user
 * gave and the answer the server is acting on can differ, and this is where
 * that gap is turned into something to show.
 *
 * The three outcomes are deliberately distinct. A server in step says nothing.
 * A server out of step says which way, because "not sharing yet" and "still
 * sharing after you said no" are not the same news. And a server we could not
 * read says so rather than borrowing either answer — the whole point of
 * checking is that assuming was what went wrong.
 */
export type ManagedTelemetryNotice =
  | { kind: 'in-step' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'stale'; consent: boolean };

export function managedTelemetryNotice(args: {
  /** Whether the managed stack is up. A stopped server transmits nothing, so it
   * cannot be violating a choice and has nothing to apply until it starts —
   * which the start itself does. */
  running: boolean;
  /** What the running stack was observed to be doing, or null when nothing has
   * been observed. */
  deployed: DeployedTelemetry | null;
  /** The user's current answer. */
  consent: boolean;
}): ManagedTelemetryNotice {
  const { running, deployed, consent } = args;
  if (!running || deployed === null) return { kind: 'in-step' };
  if (!deployed.known) return { kind: 'unknown', reason: deployed.reason };
  return deployed.enabled === consent ? { kind: 'in-step' } : { kind: 'stale', consent };
}

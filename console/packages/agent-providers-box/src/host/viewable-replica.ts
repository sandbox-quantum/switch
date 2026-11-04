import { SessionReplica, type Snapshot } from '@switch-console/shared/session-v1';

/**
 * Upstream's `SessionReplica` with a copy-free read, for checks the box host
 * runs many times a second while a session sits idle (upstream's `snapshot()`
 * clones every time). Box packages only: upstream's class is left as it is.
 * Read it straight away and let it go: it changes as events apply, and it
 * must never be changed by the caller.
 */
export class ViewableReplica extends SessionReplica {
  view(): Readonly<Snapshot> {
    return (this as unknown as { value: Snapshot }).value;
  }
}

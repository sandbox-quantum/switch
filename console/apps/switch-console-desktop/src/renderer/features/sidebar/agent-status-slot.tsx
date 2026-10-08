import type { ReactNode } from 'react';

/**
 * At most one warning on an agent's row: the first of its children that
 * renders anything.
 *
 * Every indicator is its own check, and each used to draw its own icon, so one
 * cause showed up as several — a host whose link had died read as "sessions
 * could not load", "CLI not installed" and "watcher disconnected" side by
 * side, all of them consequences of the one outage. Children go in order of
 * cause: the host first, because when it is down nothing else on the row can
 * be judged, then the agent's connection, then what depends on it. Each still
 * decides for itself whether it has anything to say (rendering nothing when
 * not), so the order here is the only thing that ranks them.
 */
export function AgentStatusSlot({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center [&>*:not(:first-child)]:hidden">
      {children}
    </span>
  );
}

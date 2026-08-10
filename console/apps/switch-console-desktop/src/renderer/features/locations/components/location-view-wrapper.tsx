import type { ReactNode } from 'react';

interface LocationViewWrapperProps {
  children: ReactNode;
  locationId: string;
  /** When set, the view is scoped to this Claude Code subagent of the location's
   * agent: Sessions lists only its sessions and Settings shows its own config. */
  agentName?: string;
  /** The room this agent page was opened from, when it was opened from a room in
   * the sidebar. The page ignores it — it is navigation context, so the sidebar
   * can highlight the row that was clicked rather than every row for the same
   * agent, and so that survives back/forward. */
  roomId?: string;
}

export function LocationViewWrapper({ children }: LocationViewWrapperProps) {
  return <>{children}</>;
}

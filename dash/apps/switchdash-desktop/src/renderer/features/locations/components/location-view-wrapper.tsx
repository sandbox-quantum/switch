import type { ReactNode } from 'react';

interface LocationViewWrapperProps {
  children: ReactNode;
  locationId: string;
  /** When set, the view is scoped to this Claude Code subagent of the location's
   * agent: Sessions lists only its sessions and Settings shows its own config. */
  agentName?: string;
}

export function LocationViewWrapper({ children }: LocationViewWrapperProps) {
  return <>{children}</>;
}

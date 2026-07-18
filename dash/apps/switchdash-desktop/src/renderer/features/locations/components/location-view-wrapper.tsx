import type { ReactNode } from 'react';

interface LocationViewWrapperProps {
  children: ReactNode;
  locationId: string;
  /** When set, the view is scoped to this Claude Code subagent of the project's
   * agent: Sessions lists only its sessions and Settings shows its own config. */
  subagentName?: string;
}

export function LocationViewWrapper({ children }: LocationViewWrapperProps) {
  return <>{children}</>;
}

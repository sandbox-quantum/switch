import { useEffect } from "react";

const listeners = new Set<() => void>();

/** Says the organization was just renamed. The top bar names it beside the
 * workspace, read when the workspace changes; it hears of a rename made in
 * Organization settings › General from here. */
export function announceOrganizationRenamed(): void {
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the organization is renamed on this page. */
export function useOrganizationRenamed(listener: () => void): void {
  useEffect(() => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listener]);
}

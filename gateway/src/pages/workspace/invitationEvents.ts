import { useEffect } from "react";

const listeners = new Set<() => void>();

/** Says an invite link was just created. The top bar's "Invite people"
 * creates one while Settings › Users may be listing them, so the list hears
 * of it from here rather than from whichever dialog made it. */
export function announceInvitationCreated(): void {
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever an invite link is created on this page. */
export function useInvitationCreated(listener: () => void): void {
  useEffect(() => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listener]);
}

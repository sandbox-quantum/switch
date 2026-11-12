import { useCallback, useEffect, useState } from "react";
import { startWebSignIn } from "../../data/api";

/** Leave for the vendor's sign-in page. The browser comes back to the
 * connector's page, which says how it ended; the caller only hears of a
 * sign-in that could not start. */
export async function leaveToSignIn(service: string): Promise<void> {
  const { url } = await startWebSignIn(service);
  window.location.assign(url);
}

/**
 * Which connector this page is leaving to sign in to, and the way to leave.
 * Leaving is cleared when a sign-in could not start (the error is rethrown
 * for the page to show), and when the browser brings the page back from its
 * back-forward cache: pressing Back at the vendor restores the page as it was
 * left, which would otherwise keep its spinner and a disabled button.
 */
export function useLeaveToSignIn(): { leaving: string | null; leave: (service: string) => Promise<void> } {
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const leave = useCallback(async (service: string) => {
    setLeaving(service);
    try {
      await leaveToSignIn(service);
    } catch (err) {
      setLeaving(null);
      throw err;
    }
  }, []);
  return { leaving, leave };
}

import { useCallback, useEffect, useState } from "react";
import { startWebSignIn } from "../../data/api";

/** Where Back on a connector's page leads, when the page that opened it
 * said. */
export interface Back {
  label: string;
  to: string;
}

/** The connector page comes back from the vendor by a fresh load, which
 * carries no history state, so where its Back led waits here: session
 * storage, for this tab alone. */
const BACK_KEY = "switch.connectorBackAfterSignIn";

/** Long enough to sign in at the vendor, short enough that one abandoned and
 * started again much later does not lead somewhere stale. */
const BACK_KEPT_MS = 15 * 60 * 1000;

/** Leave for the vendor's sign-in page, keeping `back` for the way back. The
 * browser comes back to the connector's page, which says how it ended; the
 * caller only hears of a sign-in that could not start. */
export async function leaveToSignIn(service: string, back: Back | null): Promise<void> {
  const { url } = await startWebSignIn(service);
  if (back === null) window.sessionStorage.removeItem(BACK_KEY);
  else window.sessionStorage.setItem(BACK_KEY, JSON.stringify({ service, back, at: Date.now() }));
  window.location.assign(url);
}

/** Where Back led on `service`'s page before it left to sign in, once:
 * taking it forgets it. Null when nothing was kept for that connector, or it
 * waited too long. */
export function takeBackAfterSignIn(service: string): Back | null {
  const raw = window.sessionStorage.getItem(BACK_KEY);
  window.sessionStorage.removeItem(BACK_KEY);
  if (raw === null) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof kept !== "object" || kept === null) return null;
  const { service: keptFor, back, at } = kept as Record<string, unknown>;
  if (keptFor !== service || typeof at !== "number" || Date.now() - at > BACK_KEPT_MS) return null;
  if (typeof back !== "object" || back === null) return null;
  const { label, to } = back as Record<string, unknown>;
  // Only a page of this dashboard: what is kept is followed by `navigate`.
  if (typeof label !== "string" || typeof to !== "string" || !/^\/(?!\/)/.test(to)) return null;
  return { label, to };
}

/**
 * Which connector this page is leaving to sign in to, and the way to leave.
 * Leaving is cleared when a sign-in could not start (the error is rethrown
 * for the page to show), and when the browser brings the page back from its
 * back-forward cache: pressing Back at the vendor restores the page as it was
 * left, which would otherwise keep its spinner and a disabled button.
 */
export function useLeaveToSignIn(): {
  leaving: string | null;
  leave: (service: string, back: Back | null) => Promise<void>;
} {
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const leave = useCallback(async (service: string, back: Back | null) => {
    setLeaving(service);
    try {
      await leaveToSignIn(service, back);
    } catch (err) {
      setLeaving(null);
      throw err;
    }
  }, []);
  return { leaving, leave };
}

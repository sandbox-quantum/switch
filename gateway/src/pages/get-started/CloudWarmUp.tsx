import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { AGENT_MANAGEMENT, GATEWAY_ONBOARDING } from "../../data/featureFlags";
import { fetchManagedAgents } from "../../data/management";
import { ensureCloudMachine, fetchHostedMachines } from "./onboarding";
import { GET_STARTED } from "./paths";

/** Remembers, per person and workspace, that the dashboard already sent them to Get started once. */
function sentKey(userId: string, tenantId: string): string {
  return `switch.get-started.sent:${userId}:${tenantId}`;
}

/** Warmed in this tab already, so a page change does not ask again. */
const warmed = new Set<string>();

/**
 * Starts the person's cloud device as soon as they are in a workspace that
 * may have one, so it is warm by the time they need it, and the first time
 * someone with no agents arrives, takes them to Get started. Renders nothing.
 */
export default function CloudWarmUp() {
  const { user, session, capabilities } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const on =
    capabilities.features[GATEWAY_ONBOARDING] === true &&
    capabilities.features[AGENT_MANAGEMENT] === true;
  const userId = user?.id ?? null;
  const tenantId = session?.tenant?.id ?? null;

  useEffect(() => {
    if (!on || userId === null || tenantId === null) return;
    const key = sentKey(userId, tenantId);
    if (warmed.has(key)) return;
    warmed.add(key);
    void (async () => {
      try {
        const hosted = await fetchHostedMachines();
        if (!hosted.available && hosted.machines.length === 0) return;
        // One that cannot be had now is said on Get started, which asks again.
        if (hosted.machines.length === 0)
          await ensureCloudMachine().catch((caught: unknown) =>
            console.warn("Your cloud device could not be started ahead of time:", caught),
          );
        if (localStorage.getItem(key) !== null) return;
        const agents = await fetchManagedAgents();
        localStorage.setItem(key, new Date().toISOString());
        if (agents.length === 0 && window.location.pathname !== GET_STARTED) navigate(GET_STARTED);
      } catch (caught) {
        warmed.delete(key);
        console.warn("Whether to open Get started could not be read:", caught);
      }
    })();
  }, [on, userId, tenantId, navigate]);

  // Getting there by any route counts as having been sent.
  useEffect(() => {
    if (on && userId !== null && tenantId !== null && pathname === GET_STARTED)
      localStorage.setItem(sentKey(userId, tenantId), new Date().toISOString());
  }, [on, userId, tenantId, pathname]);

  return null;
}

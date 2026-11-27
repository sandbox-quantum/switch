import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { AGENT_MANAGEMENT, GATEWAY_ONBOARDING, SWITCH_BUDDY } from "../../data/featureFlags";
import { type CloudMachine, fetchManagedAgents } from "../../data/management";
import { ensureCloudMachine, fetchHostedMachines, wakeCloudMachine } from "./onboarding";
import { GET_STARTED, sentKey } from "./paths";

/** Warmed in this tab already, so a page change does not ask again. */
const warmed = new Set<string>();

/** Whether this arrival is a first visit with no agents yet, asked once per tab. */
const decisions = new Map<string, Promise<boolean>>();

/**
 * Whether to send this person to Get started now: the first time they arrive
 * in a workspace where cloud devices can be had, with no agents yet. Asking
 * marks it as done, unless no device could be had, so a visit where Get
 * started could only say so doesn't count.
 */
export function firstVisitWithoutAgents(userId: string, tenantId: string): Promise<boolean> {
  const key = sentKey(userId, tenantId);
  const asked = decisions.get(key);
  if (asked) return asked;
  if (localStorage.getItem(key) !== null) return Promise.resolve(false);
  const decision = (async () => {
    const [hosted, agents] = await Promise.all([fetchHostedMachines(), fetchManagedAgents()]);
    if (!hosted.available && hosted.machines.length === 0) return false;
    localStorage.setItem(key, new Date().toISOString());
    return agents.length === 0;
  })();
  decision.catch(() => decisions.delete(key));
  decisions.set(key, decision);
  return decision;
}

/**
 * Forgets that this person was sent to Get started in this workspace, so the
 * next time they arrive (after Start over signs them out) it runs as on a
 * first visit: the device warmed, and Get started opened.
 */
export function forgetGetStartedVisit(userId: string, tenantId: string): void {
  const key = sentKey(userId, tenantId);
  localStorage.removeItem(key);
  warmed.delete(key);
  decisions.delete(key);
}

/**
 * Holds the dashboard back on an arrival that may be a first visit, until it
 * is known whether to open Get started, so the person goes there straight
 * rather than seeing Home first. The shell only puts this in place when
 * nothing says the person was sent there already.
 */
export function FirstVisitGate({ children }: { children: ReactNode }) {
  const { user, session, capabilities } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id ?? null;
  const tenantId = session?.tenant?.id ?? null;
  // Get started ends on meeting switch-buddy, so a server without it is not sent there.
  const buddyOffered = capabilities.features[SWITCH_BUDDY] === true;
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    if (!buddyOffered || userId === null || tenantId === null) {
      setDecided(true);
      return;
    }
    let live = true;
    firstVisitWithoutAgents(userId, tenantId)
      .then((send) => {
        if (send && live) navigate(GET_STARTED, { replace: true });
      })
      .catch((caught: unknown) => console.warn("Whether to open Get started could not be read:", caught))
      .finally(() => {
        if (live) setDecided(true);
      });
    return () => {
      live = false;
    };
  }, [buddyOffered, userId, tenantId, navigate]);

  return decided ? <>{children}</> : null;
}

/**
 * Starts the person's cloud device as soon as they are in a workspace that
 * may have one, so it is warm by the time they need it; on a first visit with
 * no agents, one asleep or stopped is started too. Renders nothing.
 */
export default function CloudWarmUp() {
  const { user, session, capabilities } = useAuth();
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
        if (!hosted.available) return;
        const isFirstVisit = await firstVisitWithoutAgents(userId, tenantId);
        let machine: CloudMachine | null = hosted.machines[0] ?? null;
        if ((machine === null || machine.desired_state === "retained") && isFirstVisit) {
          machine = await ensureCloudMachine().catch((caught: unknown): CloudMachine | null => {
            console.warn("Your cloud device could not be started ahead of time:", caught);
            return null;
          });
        }
        if (machine !== null && isFirstVisit) {
          await wakeCloudMachine(machine).catch((caught: unknown) =>
            console.warn("Your cloud device could not be started ahead of time:", caught),
          );
        }
      } catch (caught) {
        warmed.delete(key);
        console.warn("Your cloud device could not be started ahead of time:", caught);
      }
    })();
  }, [on, userId, tenantId]);

  return null;
}

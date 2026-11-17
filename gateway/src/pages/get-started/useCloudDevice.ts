import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloudMachine,
  type Controller,
  type ManagedAgent,
  fetchControllers,
  fetchManagedAgents,
} from "../../data/management";
import { ensureCloudMachine, fetchHostedMachines } from "./onboarding";

/** How often the device, its report and the person's agents are read again while the page is open. */
const POLL_MS = 3000;

export type CloudSnapshot = {
  /** False when Switch offers this workspace no cloud devices. */
  available: boolean;
  machine: CloudMachine | null;
  controller: Controller | null;
  agents: ManagedAgent[];
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The person's cloud device, its controller and their agents, read now and
 * every few seconds; the device is claimed and started if they have none.
 */
export function useCloudDevice(): {
  snapshot: CloudSnapshot | null;
  error: string | null;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ensured = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const read = useCallback(async () => {
    try {
      const hosted = await fetchHostedMachines();
      let machine = hosted.machines[0] ?? null;
      if (machine === null && !hosted.available) {
        if (timer.current !== null) clearInterval(timer.current);
        setSnapshot({
          available: false,
          machine: null,
          controller: null,
          agents: await fetchManagedAgents(),
        });
        return;
      }
      if (machine === null && !ensured.current) {
        ensured.current = true;
        // Asked again on the next read when it cannot be had now (all in use, say).
        machine = await ensureCloudMachine().finally(() => {
          ensured.current = false;
        });
      }
      const [controllers, agents] = await Promise.all([fetchControllers(), fetchManagedAgents()]);
      const controller = controllers.find((each) => each.id === machine?.controller_id) ?? null;
      setSnapshot({ available: true, machine, controller, agents });
      setError(null);
    } catch (caught) {
      setError(message(caught, "Switch Cloud could not be reached."));
    }
  }, []);

  useEffect(() => {
    void read();
    timer.current = setInterval(() => void read(), POLL_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [read]);

  const refresh = useCallback(() => void read(), [read]);
  return { snapshot, error, refresh };
}

/** Whether the device runs and can be given a login: up, connected, and holding its key. */
export function deviceReady(snapshot: CloudSnapshot | null): boolean {
  return (
    snapshot?.machine?.state === "ready" &&
    snapshot.controller?.state === "online" &&
    Boolean(snapshot.controller.public_key)
  );
}

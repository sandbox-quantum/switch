import { useCallback, useEffect, useRef, useState } from "react";
import { type Controller, fetchControllers } from "../../data/management";

const POLL_MS = 3000;

export type LocalDeviceSnapshot = {
  controllers: Controller[];
  selected: Controller | null;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The person's own devices (controllers), read now and every few seconds.
 * When one is selected, it stays selected even as the list updates.
 */
export function useLocalDevice(): {
  snapshot: LocalDeviceSnapshot | null;
  error: string | null;
  refresh: () => void;
  select: (controllerId: string | null) => void;
} {
  const [snapshot, setSnapshot] = useState<LocalDeviceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const read = useCallback(async () => {
    try {
      const controllers = await fetchControllers();
      const online = controllers.filter((c) => c.state === "online");
      const selected = selectedId ? online.find((c) => c.id === selectedId) ?? null : online[0] ?? null;
      setSnapshot({ controllers: online, selected });
      setError(null);
    } catch (caught) {
      setError(message(caught, "Devices could not be reached."));
    }
  }, [selectedId]);

  useEffect(() => {
    void read();
    timer.current = setInterval(() => void read(), POLL_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [read]);

  const refresh = useCallback(() => void read(), [read]);
  const select = useCallback((controllerId: string | null) => setSelectedId(controllerId), []);

  return { snapshot, error, refresh, select };
}

/** Whether the controller runs and can be given a login: up, connected, and holding its key. */
export function localDeviceReady(controller: Controller | null): boolean {
  return controller?.state === "online" && Boolean(controller.public_key);
}

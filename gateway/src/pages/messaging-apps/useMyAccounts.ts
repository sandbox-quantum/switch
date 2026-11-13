import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchMyIdentities,
  fetchMyPendingIdentities,
  type LinkedIdentity,
  type PendingIdentity,
} from "../../data/api";

/** How often a screen waiting on a code looks for it having been posted.
 * Nothing tells the page when it is, so it asks. */
export const CONFIRMATION_POLL_MS = 3000;

export interface MyAccounts {
  /** The accounts linked to the signed-in person, or null until the first
   *  read succeeds: unknown, never "none". */
  linked: LinkedIdentity[] | null;
  /** The accounts waiting for a code, null as for `linked`. */
  pending: PendingIdentity[] | null;
  /** When each list last arrived (0 before then), for telling which of two
   *  lists read apart is the newer. */
  linkedReadAt: number;
  pendingReadAt: number;
  /** When the read that brought the linked list was asked (0 before then):
   *  an answer can only speak for what happened before its question. */
  linkedAskedAt: number;
  /** The last read's failure, cleared by a read that works. The lists keep
   *  what they last held. */
  error: string | null;
  refresh: () => void;
}

/**
 * The signed-in person's chat accounts in this workspace: the links that
 * count and the ones waiting for a code, read apart because Switch serves
 * them apart. `pollMs` re-reads on an interval while set, for a screen
 * waiting on a code; a tick that finds a read still running is skipped.
 */
export function useMyAccounts(pollMs: number | null): MyAccounts {
  const [linked, setLinked] = useState<{ list: LinkedIdentity[]; at: number; askedAt: number } | null>(null);
  const [pending, setPending] = useState<{ list: PendingIdentity[]; at: number } | null>(null);
  const [linkedError, setLinkedError] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const alive = useRef(true);
  // Reads are numbered so a slow one, answer or failure, never lands over a
  // newer one's.
  const issued = useRef(0);
  const settledLinked = useRef(0);
  const settledPending = useRef(0);
  const running = useRef(0);

  const load = useCallback(async () => {
    const seq = ++issued.current;
    const askedAt = Date.now();
    running.current += 1;
    const newest = (settled: { current: number }) => {
      if (!alive.current || seq < settled.current) return false;
      settled.current = seq;
      return true;
    };
    try {
      await Promise.all([
        fetchMyIdentities().then(
          (list) => {
            if (!newest(settledLinked)) return;
            setLinked({ list, at: Date.now(), askedAt });
            setLinkedError(null);
          },
          (e: unknown) => {
            if (newest(settledLinked)) setLinkedError(messageOf(e));
          },
        ),
        fetchMyPendingIdentities().then(
          (list) => {
            if (!newest(settledPending)) return;
            setPending({ list, at: Date.now() });
            setPendingError(null);
          },
          (e: unknown) => {
            if (newest(settledPending)) setPendingError(messageOf(e));
          },
        ),
      ]);
    } finally {
      running.current -= 1;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => {
      if (running.current === 0) void load();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  // Never skipped for a read already running: that read may have started
  // before the change this one is meant to show.
  const refresh = useCallback(() => void load(), [load]);

  return {
    linked: linked?.list ?? null,
    pending: pending?.list ?? null,
    linkedReadAt: linked?.at ?? 0,
    pendingReadAt: pending?.at ?? 0,
    linkedAskedAt: linked?.askedAt ?? 0,
    error: linkedError ?? pendingError,
    refresh,
  };
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "Your session has ended. Sign in again.";
  return e instanceof Error ? e.message : String(e);
}

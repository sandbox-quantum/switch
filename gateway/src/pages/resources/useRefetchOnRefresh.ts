import { useEffect, useRef } from "react";

/** Calls `refetch` each time `refreshKey` changes, but not on the first
 * render: the query hooks already fetch when they mount, so a refetch then
 * would ask the server for the same list twice. The key last seen is kept
 * rather than a "first run" flag, so StrictMode running the effect twice on
 * mount does not count as a change either. */
export function useRefetchOnRefresh(refreshKey: number, refetch: () => void) {
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    refetch();
    // Only a new key asks for a refetch; the callback is the current render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
}

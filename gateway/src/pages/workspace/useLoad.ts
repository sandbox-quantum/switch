import { useCallback, useEffect, useRef, useState } from "react";

/** Load with the error kept: these calls fail for reasons the person should
 * read (not an admin, workspace gone), not only for being offline. Only the
 * latest load's answer is kept, so an earlier one landing late can't
 * overwrite it. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const refetch = useCallback(async () => {
    const request = ++latest.current;
    try {
      const loaded = await load();
      if (request !== latest.current) return;
      setData(loaded);
      setError(null);
    } catch (err) {
      if (request !== latest.current) return;
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}

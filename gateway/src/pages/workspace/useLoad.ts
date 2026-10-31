import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../data/api";

/** Load with the error kept: these calls fail for reasons the person should
 * read (not an admin, workspace gone), not only for being offline. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The HTTP status of a refusal, so a caller can tell an expected 403 from
  // a failure; null for anything that was not an answer from the server.
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
      setErrorStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setErrorStatus(err instanceof ApiError ? err.status : null);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, errorStatus, loading, refetch };
}

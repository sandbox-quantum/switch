import { Alert, Box, Button, Stack } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dismissOwnerNotice,
  fetchOwnerNotices,
  OwnerNoticesUnsupported,
  type OwnerNotice,
} from "../data/ownerNotices";

/** Notices are private to the signed-in owner and survive a closed browser. */
export default function OwnerNotices({ ownerId, tenantId }: { ownerId: string; tenantId: string }) {
  const [notices, setNotices] = useState<OwnerNotice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const result = await fetchOwnerNotices(signal);
      if (result.some((notice) => notice.owner_id !== ownerId || notice.tenant_id !== tenantId)) {
        throw new Error("The signed-in workspace changed.");
      }
      if (mounted.current && current === generation.current) {
        setNotices(result);
        setError(null);
        setSessionChanged(false);
      }
    } catch (reason) {
      if (mounted.current && current === generation.current && !signal?.aborted) {
        setNotices([]);
        const changed =
          reason instanceof Error && reason.message === "The signed-in workspace changed.";
        setSessionChanged(changed);
        setError(
          changed
            ? "Your signed-in account or workspace changed. Reload this page."
            : reason instanceof OwnerNoticesUnsupported
              ? "This server does not support owner notices. Update it to receive them."
              : "Could not load owner notices. Retrying automatically.",
        );
      }
    }
  }, [ownerId, tenantId]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 30_000);
    return () => {
      mounted.current = false;
      generation.current++;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const dismiss = async (id: string) => {
    setDismissing(id);
    try {
      await dismissOwnerNotice(id);
      if (!mounted.current) return;
      generation.current++;
      setNotices((current) => current.filter((notice) => notice.id !== id));
      setError(null);
      void refresh();
    } catch {
      if (mounted.current) setError("Could not dismiss the notice. Please try again.");
    } finally {
      if (mounted.current) setDismissing(null);
    }
  };

  if (notices.length === 0 && error === null) return null;
  return (
    <Box component="section" aria-label="Owner notices" sx={{ mb: 2 }}>
      <Stack spacing={1} sx={{ maxHeight: 240, overflowY: "auto" }}>
        {error !== null && (
          <Alert
            severity="error"
            action={
              sessionChanged ? (
                <Button color="inherit" size="small" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              ) : undefined
            }
          >
            {error}
          </Alert>
        )}
        {notices.map((notice) => (
          <Alert
            key={notice.id}
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={dismissing !== null}
                onClick={() => void dismiss(notice.id)}
                aria-label={`Dismiss notice for ${notice.agent_name} in ${notice.room_name}`}
              >
                Dismiss
              </Button>
            }
          >
            {notice.agent_name} was added to {notice.room_name}, but the platform did not
            identify who added it. Review the agent's addressing policy or ask a room member
            to remove it.
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}

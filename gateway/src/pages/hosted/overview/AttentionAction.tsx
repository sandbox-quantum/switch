import { Button } from "@mui/material";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { restartHostedBox, resumeHostedUser } from "../../../data/api";
import OperatorActionDialog from "../OperatorActionDialog";
import { refusal } from "../hostedActions";
import { type PauseReason, readPauseReason } from "../w5shared/pauseReason";
import type { AttentionRow } from "./health";

/** Where Open goes: the box's own page (engineer-4's detail page). */
export function boxPageFor(boxKeyedId: string): string {
  return `/hosted/boxes/${encodeURIComponent(boxKeyedId)}`;
}

/**
 * One quick action for a "Needs attention" row: Resume for a paused box,
 * Restart for an awake box with no recent report, and Open (the box's page)
 * for the rest. Only actions operators already have, each through
 * the shared confirm with a reason, which Core records in the audit log.
 * Resume's confirm says why they were paused (security's condition), read
 * from the audit log when it opens, as the Boxes tab does.
 */
export default function AttentionAction({ row, onDone }: { row: AttentionRow; onDone: () => void }) {
  const action = row.action;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pausedBecause, setPausedBecause] = useState<PauseReason>({ kind: "loading" });
  const user = row.box.user;

  useEffect(() => {
    if (!open || action !== "resume") return;
    const controller = new AbortController();
    setPausedBecause({ kind: "loading" });
    readPauseReason(user, controller.signal)
      .then(setPausedBecause)
      .catch(() => {
        if (!controller.signal.aborted) setPausedBecause({ kind: "error" });
      });
    return () => controller.abort();
  }, [open, action, user]);

  if (action === "open") {
    return (
      <Button size="small" variant="outlined" component={Link} to={boxPageFor(row.box.box)}>
        Open
      </Button>
    );
  }

  const confirm = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      if (action === "resume") await resumeHostedUser(row.box.user, reason);
      else await restartHostedBox(row.box.box, reason);
      setOpen(false);
      onDone();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {action === "resume" ? "Resume" : "Restart"}
      </Button>
      {open && (
        <OperatorActionDialog
          open
          action={action}
          userKeyedId={row.box.user}
          boxKeyedId={row.box.box}
          busy={busy}
          error={error}
          pausedBecause={action === "resume" ? pausedBecause : undefined}
          onCancel={() => setOpen(false)}
          onConfirm={(reason) => void confirm(reason)}
        />
      )}
    </>
  );
}

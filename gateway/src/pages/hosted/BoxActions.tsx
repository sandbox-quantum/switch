import { Button, Stack } from "@mui/material";
import { useState } from "react";
import { pauseHostedUser, restartHostedBox, resumeHostedUser } from "../../data/api";
import OperatorActionDialog from "./OperatorActionDialog";
import { refusal, type HostedAction } from "./hostedActions";

interface Props {
  userKeyedId: string;
  /** The user's box, or null for a paused person with no box (only Resume
   *  then; see `PausedWithoutBox`). */
  boxKeyedId: string | null;
  /** The user is paused by Switch: Resume shows instead of Pause. */
  paused: boolean;
  /** The box is running: only then is Restart offered (Core refuses others). */
  running: boolean;
  /** Called after an action is accepted, so the list reloads. */
  onDone: () => void;
}

const CALLS: Record<
  HostedAction,
  (user: string, box: string | null, reason: string) => Promise<unknown>
> = {
  pause: (user, _box, reason) => pauseHostedUser(user, reason),
  resume: (user, _box, reason) => resumeHostedUser(user, reason),
  restart: (_user, box, reason) =>
    box === null ? Promise.reject(new Error("no box")) : restartHostedBox(box, reason),
};

/** The operator's actions for one row of W4's Boxes table (W6). Every action
 * goes through the shared dialog with a reason; the server checks the
 * operator role on each call, so these buttons are tidiness, not the guard. */
export default function BoxActions({ userKeyedId, boxKeyedId, paused, running, onDone }: Props) {
  const [action, setAction] = useState<HostedAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: HostedAction) => {
    setError(null);
    setAction(next);
  };
  const confirm = async (reason: string) => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await CALLS[action](userKeyedId, boxKeyedId, reason);
      setAction(null);
      onDone();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack direction="row" spacing={1}>
        {paused ? (
          <Button size="small" variant="outlined" onClick={() => open("resume")}>
            Resume
          </Button>
        ) : (
          <Button size="small" variant="outlined" onClick={() => open("pause")}>
            Pause user
          </Button>
        )}
        {running && !paused && boxKeyedId !== null && (
          <Button size="small" variant="outlined" onClick={() => open("restart")}>
            Restart box
          </Button>
        )}
      </Stack>
      {action && (
        <OperatorActionDialog
          open
          action={action}
          userKeyedId={userKeyedId}
          boxKeyedId={boxKeyedId}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onConfirm={(reason) => void confirm(reason)}
        />
      )}
    </>
  );
}

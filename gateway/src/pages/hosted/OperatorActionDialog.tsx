import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { REASON_HINT, REASON_LIMIT, WORDING, title, type HostedAction } from "./hostedActions";
import type { PauseReason } from "./w5shared/pauseReason";
import { shortTime } from "./w5shared/operatorFetch";

interface Props {
  open: boolean;
  action: HostedAction;
  userKeyedId: string;
  boxKeyedId: string | null;
  busy: boolean;
  /** A fixed refusal line (`refusal()`), never the server's own text. */
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  /** For Resume: why they were paused, read from the audit log. */
  pausedBecause?: PauseReason;
}

/** The most of an operator's reason the confirm shows (security's cap). */
export const REASON_SHOWN = 300;

/** A reason cut to `REASON_SHOWN` characters, with an ellipsis when cut.
 *  Counted by code point, so an emoji is never split in half. */
export function capped(reason: string): string {
  const chars = Array.from(reason.trim());
  return chars.length <= REASON_SHOWN ? chars.join("") : `${chars.slice(0, REASON_SHOWN).join("")}…`;
}

/** Resume's "Why they were paused" line. An operator's reason is shown as
 *  text only, never markup. */
export function pausedLine(paused: PauseReason): string {
  switch (paused.kind) {
    case "loading":
      return "Checking the audit log…";
    case "found":
      return `${capped(paused.reason)} (paused ${shortTime(paused.at)})`;
    case "none":
      return "No reason is recorded. Switch may have paused them itself.";
    case "error":
      return "Couldn't read the audit log. Check it before resuming.";
  }
}

/** The shared confirm pattern (spec rule 7) for an operator's action: what
 * happens, what the person sees, and a required reason, recorded in the
 * operators' audit log. The reason is shown only as text and is cleared when
 * the dialog closes, so nothing of it is kept on the page. */
export default function OperatorActionDialog({
  open,
  action,
  userKeyedId,
  boxKeyedId,
  busy,
  error,
  onCancel,
  onConfirm,
  pausedBecause,
}: Props) {
  const [reason, setReason] = useState("");
  const words = WORDING[action];
  const trimmed = reason.trim();
  const ready = !busy && trimmed.length > 0 && trimmed.length <= REASON_LIMIT;
  const close = () => {
    setReason("");
    onCancel();
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>{title(action, userKeyedId, boxKeyedId)}</DialogTitle>
      <DialogContent>
        {action === "resume" && pausedBecause && (
          <>
            <Typography variant="overline" color="text.secondary">
              Why they were paused
            </Typography>
            <Typography variant="body2" gutterBottom data-testid="paused-because">
              {pausedLine(pausedBecause)}
            </Typography>
          </>
        )}
        <Typography variant="overline" color="text.secondary">
          What happens
        </Typography>
        <Typography variant="body2" gutterBottom>
          {words.whatHappens}
        </Typography>
        <Typography variant="overline" color="text.secondary">
          What they see
        </Typography>
        <Typography
          variant="body2"
          sx={{ bgcolor: "action.hover", borderRadius: 1, px: 1.5, py: 1, mb: 1.5 }}
        >
          {words.whatTheySee}
        </Typography>
        <TextField
          label="Reason (required, recorded in the audit log)"
          placeholder={words.placeholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          autoComplete="off"
          inputProps={{ maxLength: REASON_LIMIT }}
          helperText={REASON_HINT}
        />
        {error && (
          <Typography role="alert" variant="body2" color="error" sx={{ mt: 1 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        {/* Resume undoes a stop, so it takes the main colour; Pause and Restart stay red. */}
        <Button
          variant="contained"
          color={action === "resume" ? "primary" : "error"}
          onClick={() => onConfirm(trimmed)}
          disabled={!ready}
        >
          {words.button}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

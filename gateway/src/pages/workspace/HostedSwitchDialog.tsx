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

export const REASON_LIMIT = 500;
// The same hint as everywhere else (PM): an admin change's record can reach
// the operators' log, where only ids belong.
export const REASON_HINT = "Don't include names, messages or secrets. Up to 500 characters.";

interface Props {
  open: boolean;
  /** true to turn hosted agents on, false to turn them off. */
  enabling: boolean;
  personName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/** The shared confirm pattern (spec rule 7) for an admin's hosted agents
 * switch: what happens, what the person will see, and a required short reason
 * (the lead's decision), recorded in the workspace's activity. */
export default function HostedSwitchDialog({
  open,
  enabling,
  personName,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const ready = !busy && trimmed.length > 0 && trimmed.length <= REASON_LIMIT;
  const firstName = personName.split(" ")[0] || personName;
  const close = () => {
    setReason("");
    onCancel();
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>
        Turn {enabling ? "on" : "off"} hosted agents for {personName}?
      </DialogTitle>
      <DialogContent>
        <Typography variant="overline" color="text.secondary">
          What happens
        </Typography>
        <Typography variant="body2" gutterBottom>
          {enabling
            ? `${firstName}'s agents in this workspace can start again. Their next message starts the box. If ${firstName}'s AI login was cleared when they were turned off, they'll be asked to set it up again.`
            : `${firstName}'s agents in this workspace stop taking new work now, their AI access is cut off, and they stop within a minute. Any reply in progress is cut off. Nothing on the box is deleted.`}
        </Typography>
        <Typography variant="overline" color="text.secondary">
          What {firstName} sees
        </Typography>
        <Typography
          variant="body2"
          sx={{ bgcolor: "action.hover", borderRadius: 1, px: 1.5, py: 1, mb: 1.5 }}
        >
          {enabling
            ? "Their usual states, or \u201cCan't reply right now · Check your AI login\u201d until the login is given."
            : "Turned off by your admin · Ask your admin to turn it on"}
        </Typography>
        <TextField
          label="Reason (required, recorded in this workspace's Activity)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          placeholder={enabling ? "Why are you turning this on?" : "Why are you turning this off?"}
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
        <Button
          variant="contained"
          // Turning off is the destructive one (designer): turning on is the main dark button.
          color={enabling ? "primary" : "error"}
          onClick={() => onConfirm(trimmed)}
          disabled={!ready}
        >
          Turn {enabling ? "on" : "off"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

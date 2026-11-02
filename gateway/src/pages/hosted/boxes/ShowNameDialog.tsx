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
import { ApiError, revealHostedName } from "../../../data/api";
import { REASON_HINT, REASON_LIMIT, groupedId } from "../hostedActions";

// Copy doc 2bcf4fb6, "Show name dialog (p15)".
export const BODY =
  "Names and emails are hidden from operators by default. The name shows for this view only: it's gone when you reload, and no other operator sees it. Each time is recorded in the audit log with your reason.";
export const REASON_LABEL = "Reason (required)";
export const PLACEHOLDER = "Why do you need the name?";

/** One fixed line per refusal. The server's own text is never shown. */
export function showNameRefusal(error: unknown, kind: "user" | "workspace" = "user"): string {
  const status = error instanceof ApiError ? error.status : 0;
  switch (status) {
    case 403:
      return "Operators only";
    case 404:
      return kind === "workspace"
        ? "No workspace with that id has a box."
        : "No one with that id has a box.";
    case 422:
      return "The reason wasn't accepted. Use up to 500 characters, with no names, messages or secrets.";
    case 429:
      return "You've reached the hourly limit for showing names. Try again later.";
    default:
      return "That didn't go through. Reload the page and try again.";
  }
}

/** Only the name is kept: the email Core also sends is dropped here and
 *  never reaches the page (designer: "Name only: the email is never shown"). */
export interface Revealed {
  name: string;
}

interface Props {
  kind: "user" | "workspace";
  keyedId: string;
  onCancel: () => void;
  /** Called with the name. The caller keeps it in component state only. */
  onShown: (revealed: Revealed) => void;
}

/** p15: Show name, with a required reason. The reason goes only in the
 *  request body, and is cleared when the dialog closes. Nothing is stored,
 *  cached or logged here. */
export default function ShowNameDialog({ kind, keyedId, onCancel, onShown }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const ready = !busy && trimmed.length > 0 && trimmed.length <= REASON_LIMIT;

  const close = () => {
    setReason("");
    onCancel();
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await revealHostedName(kind, keyedId, trimmed);
      setReason("");
      onShown({ name: typeof answer?.name === "string" ? answer.name : "" });
    } catch (caught) {
      setError(showNameRefusal(caught, kind));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>
        {kind === "workspace" ? "Show the workspace name for" : "Show the user's name for"}{" "}
        {groupedId(keyedId)}?
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" gutterBottom>
          {BODY}
        </Typography>
        <TextField
          label={REASON_LABEL}
          placeholder={PLACEHOLDER}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          autoComplete="off"
          inputProps={{ maxLength: REASON_LIMIT }}
          helperText={REASON_HINT}
          sx={{ mt: 1 }}
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
        <Button variant="contained" color="error" disabled={!ready} onClick={() => void confirm()}>
          Show name
        </Button>
      </DialogActions>
    </Dialog>
  );
}

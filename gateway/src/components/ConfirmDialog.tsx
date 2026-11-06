import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { type ReactNode, useState } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** `destructive` when confirming removes something (remove a member,
   *  revoke a key, delete a workspace); `plain` otherwise (promote someone).
   *  Emphasis follows the consequence. */
  tone: "destructive" | "plain";
  /** The action itself. The dialog stays open, its buttons held, until this
   *  settles: it closes on success and shows the error on failure, so a
   *  refused action never looks like it worked. */
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      slotProps={{ transition: { onExited: () => setError(null) } }}
    >
      <DialogTitle>{title}</DialogTitle>
      {(description || error) && (
        <DialogContent>
          {description && <DialogContentText component="div">{description}</DialogContentText>}
          {error && (
            <Alert severity="error" sx={{ mt: description ? 2 : 0 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
      )}
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={tone === "destructive" ? "error" : "primary"}
          onClick={confirm}
          loading={busy}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

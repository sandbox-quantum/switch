import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
} from "@mui/material";
import { type ReactNode, useId, useRef, useState } from "react";

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
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
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
      aria-describedby={description ? descriptionId : undefined}
      slotProps={{
        transition: { onEntering: () => closeRef.current?.focus(), onExited: () => setError(null) },
        paper: { sx: { borderRadius: "16px" } },
      }}
    >
      {/* The design system's modal: a 17px title, the description 4px under it, a close
          button that takes focus first (the safe control, in a dialog whose
          main action may delete something), and a hairline over the buttons. */}
      <DialogTitle sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: description || error ? 0.5 : 3 }}>
        {title}
      </DialogTitle>
      <IconButton
        ref={closeRef}
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      {(description || error) && (
        <DialogContent sx={{ pb: 3 }}>
          {description && (
            <DialogContentText id={descriptionId} component="div" sx={{ fontSize: "0.875rem", lineHeight: "20px" }}>
              {description}
            </DialogContentText>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: description ? 2 : 0, overflowWrap: "anywhere" }}>
              {error}
            </Alert>
          )}
        </DialogContent>
      )}
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={tone === "destructive" ? "error" : "primary"}
          onClick={confirm}
          loading={busy}
          // Busy, the button keeps its colour: greyed out, a destructive
          // confirm would read as refused while the action is still running.
          sx={{
            "&.MuiButton-loading": {
              backgroundColor: tone === "destructive" ? "var(--sw-destructive)" : "primary.main",
              color: tone === "destructive" ? "var(--sw-destructive-foreground)" : "primary.contrastText",
              opacity: 0.85,
            },
          }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

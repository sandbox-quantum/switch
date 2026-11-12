import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { accountDeletionRefusal, deleteMyAccount } from "../../data/api";

interface Props {
  open: boolean;
  email: string;
  onClose: () => void;
}

type Check =
  | { state: "checking" }
  | { state: "refused"; reason: string }
  | { state: "clear" }
  // The check itself failed: the deletion still refuses whatever it would
  // have, so the form stays, saying the check didn't happen.
  | { state: "unchecked"; error: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deleting your own account, confirmed by typing its email, since an
 * account made through single sign-on has no password to ask for. Whatever
 * the deletion would refuse with, the dialog says on opening, in place of the
 * form; anything that changes in between, the deletion still refuses, and its
 * reason shows the same way. Once the account is gone this browser is signed
 * out like any other sign-out. */
export default function DeleteAccountDialog({ open, email, onClose }: Props) {
  const { logout } = useAuth();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  // Asked afresh on every opening: becoming the last admin, or no longer
  // being it, happens elsewhere.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCheck({ state: "checking" });
    setTyped("");
    setError(null);
    accountDeletionRefusal()
      .then((reason) => {
        if (current) setCheck(reason === null ? { state: "clear" } : { state: "refused", reason });
      })
      .catch((err) => {
        if (current) setCheck({ state: "unchecked", error: messageOf(err) });
      });
    return () => {
      current = false;
    };
  }, [open]);

  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const canConfirm = (check.state === "clear" || check.state === "unchecked") && matches;

  const confirm = async () => {
    if (!canConfirm || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMyAccount(typed.trim());
      setDeleted(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeleting(false);
    }
  };

  const close = () => {
    if (deleting) return;
    if (deleted) {
      // The account and its cookie are already gone, so a sign-out call that
      // fails changes nothing: loading the app again lands signed out too.
      logout().catch((err) => {
        console.warn("Signing out after deleting the account failed; reloading", err);
        window.location.assign("/");
      });
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth="xs"
      fullWidth
      aria-describedby={descriptionId}
      slotProps={{
        // Back to "checking" once closed, so reopening never shows the last
        // answer before the new one arrives.
        transition: {
          onEntering: () => closeRef.current?.focus(),
          onExited: () => setCheck({ state: "checking" }),
        },
        paper: { sx: { borderRadius: "16px" } },
      }}
    >
      {/* The design system's modal, as `ConfirmDialog` draws it. */}
      <DialogTitle sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: 0.5 }}>
        {deleted ? "Your account is deleted" : "Delete your account"}
      </DialogTitle>
      <IconButton
        ref={closeRef}
        aria-label="Close"
        onClick={close}
        disabled={deleting}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        {deleted ? (
          <DialogContentText id={descriptionId} sx={{ fontSize: "0.875rem", lineHeight: "20px" }}>
            {email} no longer has an account. Closing this signs you out.
          </DialogContentText>
        ) : check.state === "checking" ? (
          <Box
            id={descriptionId}
            role="status"
            sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1 }}
          >
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Checking whether your account can be deleted…
            </Typography>
          </Box>
        ) : check.state === "refused" ? (
          <Alert id={descriptionId} severity="warning" sx={{ mt: 1, overflowWrap: "anywhere" }}>
            <AlertTitle>You can't delete your account yet</AlertTitle>
            {check.reason}
          </Alert>
        ) : (
          <>
            <DialogContentText
              id={descriptionId}
              sx={{ fontSize: "0.875rem", lineHeight: "20px" }}
            >
              {email} will be removed from every workspace you're in. The agents you own stop and
              are deleted, along with your devices, resources, templates and connector accounts.
              Rooms you created stay, and so do your messages, under the name "Former member". A
              workspace only you are in is deleted too, unless rooms are left in it. This can't be
              undone.
            </DialogContentText>
            {check.state === "unchecked" && (
              <Alert severity="warning" sx={{ mt: 2, overflowWrap: "anywhere" }}>
                Couldn't check beforehand whether your account can be deleted ({check.error}). If
                something stands in the way, deleting it will say what.
              </Alert>
            )}
            <TextField
              fullWidth
              size="small"
              label={`Type ${email} to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void confirm();
              }}
              disabled={deleting}
              autoComplete="off"
              sx={{ mt: 2.5 }}
            />
            {error && (
              <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
                {error}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        {/* Named apart from the close icon, which is "Close". */}
        {deleted || check.state === "refused" ? (
          <Button variant="outlined" onClick={close}>
            {deleted ? "Done" : "OK"}
          </Button>
        ) : (
          <>
            <Button variant="outlined" onClick={close} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => void confirm()}
              disabled={!canConfirm}
              loading={deleting}
              // Busy, the button keeps its colour, as in `ConfirmDialog`.
              sx={{
                "&.MuiButton-loading": {
                  backgroundColor: "var(--sw-destructive)",
                  color: "var(--sw-destructive-foreground)",
                  opacity: 0.85,
                },
              }}
            >
              Delete account
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

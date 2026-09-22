import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { useState } from "react";
import { type InstalledApp, disconnectApp } from "../../data/api";
import { titleCase } from "../../theme/hootFormat";

/**
 * Disconnecting is the only way an install-created connection can be removed,
 * because it is the only one that revokes the token at the platform first.
 * Deleting the connection instead is refused, so this dialog carries the
 * warning that would otherwise sit on the delete: the rooms survive and go
 * internal-only, which is not obvious and cannot be undone by re-installing.
 *
 * It can fail with the platform's own refusal, in which case nothing has been
 * destroyed and trying again is the right move — so the error is shown here
 * rather than closing the dialog on the way out.
 */
interface Props {
  install: InstalledApp | null;
  onClose: () => void;
  onDisconnected: () => void;
}

export default function DisconnectAppDialog({
  install,
  onClose,
  onDisconnected,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    onClose();
  };

  const handleDisconnect = async () => {
    if (!install) return;
    setSubmitting(true);
    setError(null);
    try {
      await disconnectApp(install.id);
      onDisconnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!install} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Disconnect the app</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Remove Switch from the {titleCase(install?.platform ?? "")} workspace{" "}
          <b>{install?.external_workspace_id}</b>? The token is revoked at the
          platform and the connection it created is removed.
        </DialogContentText>
        <DialogContentText sx={{ mt: 2 }}>
          Rooms that used this connection are kept, but become internal-only:
          they stop mirroring to the workspace, and installing again creates a
          new connection rather than reattaching them.
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleDisconnect}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Disconnect
        </Button>
      </DialogActions>
    </Dialog>
  );
}

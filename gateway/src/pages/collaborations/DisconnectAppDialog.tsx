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
 * so this dialog carries the warning that would otherwise sit on the delete
 * (which is refused): the rooms survive and go internal-only, which is not
 * obvious and cannot be undone by re-installing.
 *
 * It can fail with the platform's own refusal, in which case nothing has been
 * destroyed and trying again is the right move — so the error is shown here
 * rather than closing the dialog on the way out.
 */

/**
 * What Disconnect actually does differs by platform, and telling an operator a
 * credential was revoked when it was not is the kind of thing that surfaces in
 * an incident review. Most platforms hold a per-install token that Disconnect
 * revokes; the distributed Discord app holds none — the bot authenticates with
 * this deployment's own application token — so disconnect only stops delivery.
 *
 * Keyed on platform as a proxy for token-presence: the backend branches on
 * whether the install has a token, but that field is not surfaced here. Any
 * platform not listed gets the default (revoking) copy.
 */
const REMOVAL_COPY: Record<string, string> = {
  discord:
    "there is no per-install token to revoke — the bot authenticates with " +
    "this deployment's own application token — so this stops delivery to the " +
    "server, but the bot stays authenticated until it is removed from the " +
    "server in Discord",
};
const DEFAULT_REMOVAL =
  "the token is revoked at the platform and the connection it created is removed";

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
          <b>{install?.external_workspace_id}</b>? On disconnect,{" "}
          {REMOVAL_COPY[install?.platform ?? ""] ?? DEFAULT_REMOVAL}.
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

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
 * What Disconnect does differs by platform, and telling an operator a
 * credential was revoked when it was not is the kind of thing that surfaces in
 * an incident review. Most platforms hold a token that Disconnect revokes and
 * so removes the app; the distributed Discord app holds none, so disconnecting
 * only stops Switch from using the bot — the bot stays in the server until it
 * is removed in Discord.
 *
 * Keyed on platform as a proxy for token-presence: the backend branches on
 * whether the install has a token, but that field is not surfaced here. Any
 * platform not listed gets the default (revoking) copy. `noun` is what the
 * platform calls the place installed into — a Discord "server", not a
 * "workspace". `rooms` is what happens to Switch's side: for most platforms
 * the whole connection goes, but a Telegram chat is one room on a connection
 * every other chat of the organisation keeps using.
 */
interface Copy {
  noun: string;
  effect: string;
  rooms: string;
}

const CONNECTION_ROOMS = (noun: string) =>
  "Rooms that used this connection are kept, but become internal-only: they " +
  `stop mirroring to the ${noun}, and installing again creates a new ` +
  "connection rather than reattaching them.";

const PLATFORM_COPY: Record<string, Copy> = {
  discord: {
    noun: "server",
    effect:
      "Switch will stop mirroring messages to and from it. The bot stays in " +
      "the server until you remove it in Discord — disconnecting here does " +
      "not remove it.",
    rooms: CONNECTION_ROOMS("server"),
  },
  telegram: {
    noun: "chat",
    effect: "The bot leaves the chat, and Switch stops mirroring it.",
    rooms:
      "The chat's room is kept, but becomes internal-only, and connecting " +
      "the chat again creates a new room rather than reattaching it. Other " +
      "connected Telegram chats are not affected.",
  },
};
const DEFAULT_COPY: Copy = {
  noun: "workspace",
  effect:
    "Switch's access token is revoked at the platform and the connection it " +
    "created is removed.",
  rooms: CONNECTION_ROOMS("workspace"),
};

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
  const copy = PLATFORM_COPY[install?.platform ?? ""] ?? DEFAULT_COPY;

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
          Disconnect Switch from the {titleCase(install?.platform ?? "")}{" "}
          {copy.noun} <b>{install?.external_workspace_id}</b>? {copy.effect}
        </DialogContentText>
        <DialogContentText sx={{ mt: 2 }}>{copy.rooms}</DialogContentText>
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

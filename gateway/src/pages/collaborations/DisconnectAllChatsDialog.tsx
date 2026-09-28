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
import { disconnectAllChats } from "../../data/api";
import { titleCase } from "../../theme/hootFormat";

interface Props {
  /** The claim-based platform to turn off, or null when closed. */
  platform: string | null;
  onClose: () => void;
  onDisconnected: () => void;
}

/** Turning a claim-based platform off for the organisation: an admin's.
 *
 *  It undoes what connecting the first chat did — the bot leaves every chat,
 *  and the connection they shared goes. It can stop part-way with the
 *  platform's own refusal, leaving the remaining chats connected, so the error
 *  is shown here and trying again finishes the job. */
export default function DisconnectAllChatsDialog({
  platform,
  onClose,
  onDisconnected,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = titleCase(platform ?? "");

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    onClose();
  };

  const handleDisconnect = async () => {
    if (!platform) return;
    setSubmitting(true);
    setError(null);
    try {
      await disconnectAllChats(platform);
      onDisconnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!platform} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Disconnect {name}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Disconnect every {name} chat from Switch? The bot leaves each chat,
          and {name} is off for this organisation until an admin connects a
          chat again.
        </DialogContentText>
        <DialogContentText sx={{ mt: 2 }}>
          Each chat&apos;s room is kept, but becomes internal-only: it stops
          mirroring to {name}, and connecting the chat again creates a new room
          rather than reattaching this one.
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
          Disconnect all
        </Button>
      </DialogActions>
    </Dialog>
  );
}

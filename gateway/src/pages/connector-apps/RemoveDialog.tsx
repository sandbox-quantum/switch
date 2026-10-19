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
import { type ConnectorApp, removeConnectorApp } from "../../data/api";
import { removeWarning } from "./connectorApps";

export default function RemoveDialog({
  app,
  open,
  onClose,
  onRemoved,
}: {
  app: ConnectorApp;
  open: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeConnectorApp(app.slug);
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose}>
      <DialogTitle>Remove {app.name}&apos;s app?</DialogTitle>
      <DialogContent>
        <DialogContentText>{removeWarning(app)}</DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={busy}
          onClick={() => void remove()}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  );
}

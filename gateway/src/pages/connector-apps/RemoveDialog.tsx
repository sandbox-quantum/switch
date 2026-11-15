import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { type ConnectorApp, removeConnectorApp } from "../../data/api";
import { removeImpact } from "./connectorApps";
import { useConnectorAppScope } from "./scope";

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
  const scope = useConnectorAppScope();
  const impact = removeImpact(app, scope);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeConnectorApp(scope, app.slug);
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
        <DialogContentText>{impact.lead}</DialogContentText>
        <Typography variant="overline" component="p" color="text.secondary" sx={{ mt: 2 }}>
          What this affects
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {impact.lines.map((line) => (
            <Typography key={line} component="li" variant="body2" sx={{ mt: 0.5 }}>
              {line}
            </Typography>
          ))}
        </Box>
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

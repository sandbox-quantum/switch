import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import {
  type ConnectorApp,
  type ConnectorAppField,
  ConnectorAppRefusal,
  type SavedConnectorApp,
  saveConnectorApp,
} from "../../data/api";
import { menuLabel, secretFields, UPDATE_SECRET_NOTE } from "./connectorApps";
import { useConnectorAppScope } from "./scope";
import { SecretInputs } from "./SetupDialog";

/**
 * A new secret (or, for GitHub, a new private key) for the same app: nobody
 * is disconnected. What is left empty keeps what is saved.
 */
export default function UpdateSecretDialog({
  app,
  open,
  onClose,
  onSaved,
}: {
  app: ConnectorApp;
  open: boolean;
  onClose: () => void;
  onSaved: (saved: SavedConnectorApp) => void;
}) {
  const scope = useConnectorAppScope();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<ConnectorAppField | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSecrets({});
    setError(null);
    setField(null);
  }, [open]);

  const given = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ""));

  const save = async () => {
    if (app.client_id === null) return;
    setBusy(true);
    setError(null);
    setField(null);
    try {
      onSaved(
        await saveConnectorApp(scope, app.slug, { client_id: app.client_id, ...given, replace: false }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setField(err instanceof ConnectorAppRefusal ? err.field : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{menuLabel(app, "update_secret")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            For the app with client ID {app.client_id}.
            {app.kind === "github_app" && " Leave either empty to keep what is saved."}
          </Typography>
          <SecretInputs
            fields={secretFields(app)}
            values={secrets}
            highlighted={field}
            onChange={(name, value) => setSecrets((current) => ({ ...current, [name]: value }))}
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2">{UPDATE_SECRET_NOTE}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || Object.keys(given).length === 0}
          onClick={() => void save()}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          {busy ? "Checking…" : "Check and save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useState } from "react";
import { type ServiceConnection, connectServiceWithKey } from "../../data/api";

/**
 * Pasting a key-based connector's key: each field the catalog asks for, a
 * secret one write-only. The vendor checks the key before Switch stores it,
 * and a refusal shows here, so a key that doesn't work is never saved.
 */
export default function KeyDialog({
  connection,
  replacing,
  onClose,
  onSaved,
}: {
  connection: ServiceConnection;
  replacing: boolean;
  onClose: () => void;
  onSaved: (warning: string | null) => void;
}) {
  const form = connection.key!;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.name, field.choices?.[0] ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = form.fields.every((field) => values[field.name]?.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { warning } = await connectServiceWithKey(connection.slug, values);
      onSaved(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {replacing ? `Replace your ${connection.name} keys` : `Add your ${connection.name} keys`}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText>
            Switch checks them with {connection.publisher ?? connection.name} before saving, and
            never shows them back.
            {form.help_url && (
              <>
                {" "}
                <Link href={form.help_url} target="_blank" rel="noreferrer">
                  Where to make them
                </Link>
              </>
            )}
          </DialogContentText>
          {form.fields.map((field) =>
            field.choices ? (
              <TextField
                key={field.name}
                select
                label={field.label}
                helperText={field.help ?? undefined}
                value={values[field.name]}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              >
                {field.choices.map((choice) => (
                  <MenuItem key={choice} value={choice}>
                    {choice}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                key={field.name}
                label={field.label}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                helperText={field.help ?? undefined}
                value={values[field.name]}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              />
            ),
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !complete}
          onClick={() => void save()}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          {replacing ? "Replace keys" : "Add keys"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

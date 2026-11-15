import { Alert, Button, CircularProgress, Stack, TextField } from "@mui/material";
import { useState } from "react";
import { createTenant } from "../../data/api";

/** Creates an organization with a first workspace of the same name, and the
 * server switches the session into that workspace (it re-mints the cookie),
 * so success reloads into the app. */
export default function CreateWorkspaceForm({ onCancel }: { onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createTenant(name.trim());
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the organization");
      setSubmitting(false);
    }
  };

  return (
    <Stack component="form" onSubmit={submit} spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Organization name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. your company or team"
        helperText="It starts with one workspace of the same name. You can add more later."
        required
        autoFocus
      />
      <Stack direction="row" spacing={1}>
        <Button
          type="submit"
          variant="contained"
          fullWidth
          disabled={submitting || name.trim() === ""}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Create organization
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

import { Alert, Button, CircularProgress, Stack, TextField } from "@mui/material";
import { useState } from "react";
import { createTenant } from "../../data/api";

/** Creating a workspace also switches the session into it (the server
 * re-mints the cookie), so success reloads into the app. */
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
      setError(err instanceof Error ? err.message : "Could not create the workspace");
      setSubmitting(false);
    }
  };

  return (
    <Stack component="form" onSubmit={submit} spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Workspace name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. your company or team"
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
          Create workspace
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

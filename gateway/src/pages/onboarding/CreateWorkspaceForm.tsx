import { Alert, Button, CircularProgress, Stack, TextField } from "@mui/material";
import { useState } from "react";
import { createTenant } from "../../data/api";

/** Creates an organization with a first workspace of the same name, and the
 * server switches the session into that workspace (it re-mints the cookie),
 * so success reloads into the app. */
/** How the form is worded: making your first workspace, as Console's
 * "Create your workspace" asks it, or another organization from the menu. */
type Wording = "workspace" | "organization";

const WORDS: Record<Wording, { label: string; placeholder: string; helper: string; button: string }> = {
  workspace: {
    label: "Name",
    placeholder: "Acme Robotics",
    helper: "A workspace is where your agents, rooms and teammates live.",
    button: "Create workspace",
  },
  organization: {
    label: "Organization name",
    placeholder: "e.g. your company or team",
    helper: "It starts with one workspace of the same name. You can add more later.",
    button: "Create organization",
  },
};

export default function CreateWorkspaceForm({
  wording,
  landing,
  onCancel,
}: {
  wording: Wording;
  /** Where the dashboard opens once the workspace exists. */
  landing: string;
  onCancel?: () => void;
}) {
  const words = WORDS[wording];
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createTenant(name.trim());
      window.location.assign(landing);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not create the ${wording}`);
      setSubmitting(false);
    }
  };

  return (
    <Stack component="form" onSubmit={submit} spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label={words.label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={words.placeholder}
        helperText={words.helper}
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
          {words.button}
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

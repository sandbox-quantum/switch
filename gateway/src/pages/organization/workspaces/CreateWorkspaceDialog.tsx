import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField,
} from "@mui/material";
import { useId, useState } from "react";
import { WORKSPACE_NAME_MAX, createOrganizationWorkspace } from "../../../data/api";
import { duplicateWorkspaceNameError } from "./copy";

interface Props {
  open: boolean;
  organizationName: string;
  /** The organization's current workspace names, to refuse a duplicate
   * before asking the server, which refuses it too. */
  existingNames: readonly string[];
  onClose: () => void;
  /** The workspace was created, named as the server stored it. The session
   * stays on whatever workspace it was already on. */
  onCreated: (name: string) => void;
}

/** Adds a workspace to the organization. Mounted only while open, so it
 * always starts from a blank name. */
export default function CreateWorkspaceDialog({
  open,
  organizationName,
  existingNames,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const trimmed = name.trim();
  const clientError =
    trimmed.length > WORKSPACE_NAME_MAX
      ? `Workspace names are at most ${WORKSPACE_NAME_MAX} characters.`
      : duplicateWorkspaceNameError(organizationName, existingNames, trimmed);
  const disabled = busy || trimmed === "" || clientError !== null;

  const close = () => {
    if (busy) return;
    setName("");
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createOrganizationWorkspace(trimmed);
      setName("");
      onCreated(created.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: 0.5 }}>
        Create workspace
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={close}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        <DialogContentText sx={{ mb: 2 }}>
          It starts with you as its admin — invite people to it from Organization settings ›
          Users.
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          label="Workspace name"
          placeholder="e.g. Quantum Chemistry"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) void submit();
          }}
          error={clientError !== null}
          helperText={clientError ?? undefined}
          slotProps={{ htmlInput: { maxLength: WORKSPACE_NAME_MAX } }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} loading={busy} disabled={disabled}>
          Create workspace
        </Button>
      </DialogActions>
    </Dialog>
  );
}

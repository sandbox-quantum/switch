import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
} from "@mui/material";
import { useId, useState } from "react";
import { WORKSPACE_NAME_MAX } from "../../../data/api";
import { duplicateWorkspaceNameError } from "./copy";

interface Props {
  workspace: { id: string; name: string };
  organizationName: string;
  /** The names of the organization's other workspaces, to refuse one of
   * them before the server does. */
  otherNames: readonly string[];
  /** The rename itself. Left to throw: the dialog shows what it says and
   * stays open, rather than closing on a refusal. */
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Renames one of the organization's workspaces. Mounted only while open, so
 * it always starts from the workspace's current name. */
export default function RenameWorkspaceDialog({
  workspace,
  organizationName,
  otherNames,
  onSave,
  onClose,
}: Props) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const trimmed = name.trim();
  const clientError = duplicateWorkspaceNameError(organizationName, otherNames, trimmed);
  const disabled = busy || trimmed === "" || trimmed === workspace.name || clientError !== null;

  const save = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: 0.5 }}>
        Rename workspace
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        <TextField
          autoFocus
          fullWidth
          label="Workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) void save();
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
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} loading={busy} disabled={disabled}>
          Rename
        </Button>
      </DialogActions>
    </Dialog>
  );
}

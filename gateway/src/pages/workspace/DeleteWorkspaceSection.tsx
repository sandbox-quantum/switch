import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { deleteWorkspace } from "../../data/api";

interface Props {
  tenantId: string;
  tenantName: string;
}

/** The owner deletes the workspace by typing its name. The server refuses
 * one that still holds anything, and its message lists what. */
export default function DeleteWorkspaceSection({ tenantId, tenantName }: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteWorkspace(tenantId, typed);
      await refresh();
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the workspace");
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "error.main", display: "block" }}>
        Danger zone
      </Typography>
      <Button
        variant="outlined"
        color="error"
        startIcon={<DeleteOutline />}
        onClick={() => setOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Delete workspace
      </Button>
      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>Delete workspace</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This deletes <b>{tenantName}</b> for good. Only an empty workspace can be
            deleted: remove its rooms, agents, resources, machines, connections and
            other members first. Type the workspace name to confirm.
          </DialogContentText>
          <TextField
            fullWidth
            size="small"
            label="Workspace name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={submitting}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={submit}
            disabled={submitting || typed.trim() !== tenantName}
            startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          >
            Delete workspace
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

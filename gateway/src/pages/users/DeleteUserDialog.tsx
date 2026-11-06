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
import { type UserInfo, deleteUser } from "../../data/api";

interface Props {
  user: UserInfo | null;
  onClose: () => void;
  onDeleted: () => void;
}

export default function DeleteUserDialog({ user, onClose, onDeleted }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    if (!user) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteUser(user.id);
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={user !== null} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Delete account</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Delete the account of <b>{user?.name}</b> ({user?.email}) in every workspace?
          This cannot be undone.
        </DialogContentText>
        <Alert severity="warning">
          Their agents, packages, references, documents, templates and API keys are
          deleted. Rooms they created stay, with no owner.
        </Alert>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleDelete}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Delete account
        </Button>
      </DialogActions>
    </Dialog>
  );
}

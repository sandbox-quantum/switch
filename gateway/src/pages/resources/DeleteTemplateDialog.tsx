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
import { deleteTemplate } from "../../data/api";

/**
 * Separate from `DeleteResourceDialog` on purpose: that one warns which rooms a
 * resource is about to be detached from, and a template is attached to nothing.
 */
interface Props {
  open: boolean;
  templateId: string;
  templateLabel: string;
  onClose: () => void;
  onDeleted: () => void;
}

export default function DeleteTemplateDialog({
  open,
  templateId,
  templateLabel,
  onClose,
  onDeleted,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    onClose();
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteTemplate(templateId);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Delete template</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Delete <b>{templateLabel}</b>? This cannot be undone. Rooms already
          created from it are unaffected.
        </DialogContentText>
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
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

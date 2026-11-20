import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { useState } from "react";
import { createDocument } from "../../data/api";
import { AccessSelect } from "../../components/AccessControls";
import { type AccessLevel, LISTED_RESOURCE_HELPERS, fromAccessLevel } from "../../data/visibility";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function CreateDocumentDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [content, setContent] = useState("");
  const [access, setAccess] = useState<AccessLevel>("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setInstructions("");
    setContent("");
    setAccess("private");
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await createDocument({
        name,
        description,
        instructions,
        content,
        ...fromAccessLevel(access),
      });
      reset();
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create document");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    content.trim().length > 0 &&
    !submitting;

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
      <DialogTitle>New document</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            helperText="Short, human-friendly label."
          />
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            multiline
            minRows={2}
            helperText="Short, human-readable summary. Shown in lists."
          />
          <TextField
            label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={submitting}
            multiline
            minRows={4}
            helperText="Sent to agents on connect. Explain how to use this document."
          />
          <TextField
            label="Content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={submitting}
            multiline
            minRows={10}
            slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
          />
          <AccessSelect
            value={access}
            onChange={setAccess}
            disabled={submitting}
            helpers={LISTED_RESOURCE_HELPERS}
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

import UploadFileIcon from "@mui/icons-material/UploadFile";
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
import { useRef, useState } from "react";
import { createTemplate } from "../../data/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function CreateTemplateDialog({
  open,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState("room");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setKind("room");
    setContent("");
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleFile = async (file: File) => {
    setError(null);
    // Read as text and hand the string on unchanged — the registry stores what
    // it is given, so anything reformatted here would be stored reformatted.
    const text = await file.text();
    setContent(text);
    if (!name.trim()) setName(file.name.replace(/\.(ya?ml)$/i, ""));
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await createTemplate({
        name: name.trim(),
        description,
        kind: kind.trim(),
        content,
      });
      reset();
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload template");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    name.trim().length > 0 &&
    kind.trim().length > 0 &&
    content.length > 0 &&
    !submitting;

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="md">
      <DialogTitle>Upload template</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            helperText="Unique among your own templates. Others may reuse it."
          />
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            multiline
            minRows={2}
            helperText="Shown in the catalogue, and searched alongside the name."
          />
          <TextField
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            disabled={submitting}
            helperText="What this template provisions — room, group, agent."
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              startIcon={<UploadFileIcon />}
              onClick={() => fileInput.current?.click()}
              disabled={submitting}
            >
              Load from file
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,text/yaml,application/x-yaml"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </Stack>
          <TextField
            label="Document"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={submitting}
            multiline
            minRows={12}
            slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
            helperText="Stored exactly as written. The registry does not parse it."
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
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}

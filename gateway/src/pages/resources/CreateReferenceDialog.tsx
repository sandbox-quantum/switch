import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useState } from "react";
import { createReference } from "../../data/api";
import { AccessSelect } from "../../components/AccessControls";
import { type AccessLevel, fromAccessLevel } from "../../data/visibility";
import { useReferenceTypes } from "../../data/hooks";
import UrlsValueForm from "./value_forms/UrlsValueForm";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function CreateReferenceDialog({ open, onClose, onCreated }: Props) {
  const { data: types } = useReferenceTypes();
  const [type, setType] = useState<string>("");
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [access, setAccess] = useState<AccessLevel>("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setType("");
    setValue({});
    setName("");
    setDescription("");
    setInstructions("");
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
      const created = await createReference({
        type,
        value,
        name,
        description,
        instructions,
        ...fromAccessLevel(access),
      });
      reset();
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create reference");
    } finally {
      setSubmitting(false);
    }
  };

  // The slug was picked from this very list, so it always resolves.
  const selectedType = (types ?? []).find((t) => t.type === type);
  const canSubmit =
    !!type && name.trim().length > 0 && description.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>New reference</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            select
            label="Type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setValue({});
            }}
            disabled={submitting}
          >
            {(types ?? []).map((t) => (
              <MenuItem key={t.type} value={t.type}>
                {t.is_builtin
                  ? t.display_name
                  : `${t.display_name} — by ${t.owner_name ?? t.owner_id}`}
              </MenuItem>
            ))}
          </TextField>

          {selectedType && (
            <UrlsValueForm
              value={value}
              onChange={setValue}
              disabled={submitting}
              helperText={selectedType.value_hint}
            />
          )}

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
            helperText="Sent to agents on connect. Explain how to use this reference."
          />

          <AccessSelect value={access} onChange={setAccess} disabled={submitting} />

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

import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import {
  type Controller,
  MAX_MACHINE_DESCRIPTION,
  MAX_MACHINE_NAME,
  updateController,
} from "../../data/management";

/**
 * Renames a machine and edits its description: what the owner sees here, and
 * what the agents allowed to manage agents for them read when they pick a
 * machine. Only the fields that changed are sent.
 */
export default function EditMachineDialog({
  machine,
  onClose,
  onSaved,
}: {
  machine: Controller | null;
  onClose: () => void;
  onSaved: (saved: Controller) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (machine === null) return;
    setName(machine.name);
    setDescription(machine.description ?? "");
    setError(null);
  }, [machine]);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameError =
    trimmedName.length === 0
      ? "A machine needs a name."
      : trimmedName.length > MAX_MACHINE_NAME
        ? `At most ${MAX_MACHINE_NAME} characters.`
        : null;
  const descriptionError =
    trimmedDescription.length > MAX_MACHINE_DESCRIPTION
      ? `At most ${MAX_MACHINE_DESCRIPTION} characters.`
      : null;

  const save = async () => {
    if (machine === null) return;
    const changes: { name?: string; description?: string | null } = {};
    if (trimmedName !== machine.name) changes.name = trimmedName;
    if (trimmedDescription !== (machine.description ?? ""))
      changes.description = trimmedDescription || null;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await updateController(machine.id, changes);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={machine !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit {machine?.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={nameError !== null}
            helperText={nameError ?? " "}
            required
            fullWidth
          />
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={descriptionError !== null}
            helperText={
              descriptionError ??
              "What the machine is for. Agents you allow to manage agents see it when they pick a machine."
            }
            multiline
            minRows={2}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={saving || nameError !== null || descriptionError !== null}
          onClick={() => void save()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

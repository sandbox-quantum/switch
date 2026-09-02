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
import { createReferenceType } from "../../data/api";
import { AccessSelect } from "../../components/AccessControls";
import { type AccessLevel, fromAccessLevel } from "../../data/visibility";
import { useReferenceTypes } from "../../data/hooks";

const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

const SLUG_RULE =
  "^[a-z][a-z0-9_]{1,62}$ — lowercase letters, digits and underscores, starting with a letter, 2–63 characters. Stored on every reference of this type, so it cannot be changed later.";

export const INSTRUCTIONS_DISCLOSURE =
  "Sent to every agent in every room a reference of this type reaches, including agents owned by other people. A private type is hidden from other people's pickers; that does not hold these instructions back once a reference of it is in a room.";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateReferenceTypeDialog({
  open,
  onClose,
  onCreated,
}: Props) {
  const { data: types } = useReferenceTypes();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [valueHint, setValueHint] = useState("");
  const [access, setAccess] = useState<AccessLevel>("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSlug("");
    setDisplayName("");
    setInstructions("");
    setValueHint("");
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
      await createReferenceType({
        type: slug,
        display_name: displayName,
        instructions,
        value_hint: valueHint,
        ...fromAccessLevel(access),
      });
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create reference type");
    } finally {
      setSubmitting(false);
    }
  };

  // Only types this user can read are known here, so a collision with someone
  // else's private slug still comes back from the server as a 400.
  const clash = (types ?? []).find((t) => t.type === slug);
  const slugError =
    slug.length === 0
      ? null
      : !SLUG_PATTERN.test(slug)
        ? `"${slug}" is not a valid slug.`
        : clash
          ? clash.is_builtin
            ? `"${slug}" is a built-in reference type.`
            : `"${slug}" is already taken.`
          : null;

  const canSubmit =
    slugError === null &&
    SLUG_PATTERN.test(slug) &&
    displayName.trim().length > 0 &&
    instructions.trim().length > 0 &&
    valueHint.trim().length > 0 &&
    !submitting;

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>New reference type</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            disabled={submitting}
            error={slugError !== null}
            helperText={slugError ? `${slugError} ${SLUG_RULE}` : SLUG_RULE}
            slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
          />

          <TextField
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            helperText="Shown wherever a reference of this type appears."
          />

          <TextField
            label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={submitting}
            multiline
            minRows={4}
            helperText={INSTRUCTIONS_DISCLOSURE}
          />

          <TextField
            label="Value hint"
            value={valueHint}
            onChange={(e) => setValueHint(e.target.value)}
            disabled={submitting}
            helperText="Shown under the URL box when someone creates a reference of this type — say what those URLs should point at."
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

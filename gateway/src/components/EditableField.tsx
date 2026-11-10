import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  Box,
  Button,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  OutlinedInput,
  Stack,
} from "@mui/material";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { tokenVar } from "../theme/tokens";

interface Props {
  label: string;
  /** What is stored. View mode always shows this, never a copy of it. */
  value: string;
  /** False drops the pencil rather than disabling it: a control nobody here
   * can ever use is noise. */
  canEdit: boolean;
  /** Who can change it, said only to someone who can't. */
  readOnlyHelper: string;
  /** The pencil's accessible name, "Rename workspace". */
  editLabel: string;
  maxLength: number;
  /** Stores the trimmed draft. A rejection's message shows under the field,
   * which stays open with what was typed. */
  onSave: (draft: string) => Promise<void>;
}

// Read-only, as the design system draws it: the cream fill, the border
// kept, no shadow, and no hover, since the box itself does nothing.
const READ_ONLY = {
  backgroundColor: tokenVar("field-readonly"),
  boxShadow: "none",
  "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: tokenVar("field-border") },
  "& .MuiOutlinedInput-input": { fontWeight: 500 },
};

/** One value, shown read-only with a pencil beside it; the pencil opens it
 * for editing, with Cancel and Update below. Enter updates and Escape
 * cancels. Update waits for a change: a blank name, or the one already
 * stored, has nothing to update. */
export default function EditableField({
  label,
  value,
  canEdit,
  readOnlyHelper,
  editLabel,
  maxLength,
  onSave,
}: Props) {
  const id = useId();
  const helperId = `${id}-helper`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Read by `save` itself, so two calls before a render cannot both send.
  const sending = useRef(false);

  // Back on the pencil when editing ends, so the keyboard is where it was.
  const pencil = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) pencil.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const trimmed = draft.trim();
  const changed = trimmed !== "" && trimmed !== value;

  const startEdit = () => {
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (saving) return;
    setEditing(false);
  };

  const save = async () => {
    if (!changed || sending.current) return;
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save it");
    } finally {
      sending.current = false;
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that ends an input method's composition is not a submit.
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const helper = editing ? error : canEdit ? null : readOnlyHelper;

  return (
    <FormControl error={editing && error !== null} sx={{ maxWidth: 420 }} fullWidth>
      <InputLabel htmlFor={id}>{label}</InputLabel>
      {editing ? (
        <OutlinedInput
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          // Held rather than disabled while it saves, so it keeps the focus
          // for a correction if the save is refused.
          readOnly={saving}
          autoFocus
          size="small"
          inputProps={{
            maxLength,
            "aria-describedby": helper ? helperId : undefined,
          }}
        />
      ) : (
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <OutlinedInput
            id={id}
            value={value}
            readOnly
            size="small"
            fullWidth
            sx={READ_ONLY}
            inputProps={{ "aria-describedby": helper ? helperId : undefined }}
          />
          {canEdit && (
            <IconButton ref={pencil} aria-label={editLabel} onClick={startEdit} color="primary">
              <EditOutlined sx={{ fontSize: 18 }} />
            </IconButton>
          )}
        </Stack>
      )}
      {helper && <FormHelperText id={helperId}>{helper}</FormHelperText>}
      {editing && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 1.5 }}>
          <Button variant="outlined" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void save()} disabled={!changed || saving}>
            Update
          </Button>
        </Box>
      )}
    </FormControl>
  );
}

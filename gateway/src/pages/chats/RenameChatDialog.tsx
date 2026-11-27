import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";

export function RenameChatDialog({
  open,
  currentName,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  currentName: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(currentName);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== currentName;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        component: "form",
        onSubmit: (e: React.FormEvent) => {
          e.preventDefault();
          if (valid) onConfirm(trimmed);
        },
      }}
    >
      <DialogTitle>Rename chat</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          margin="dense"
          label="Name"
          type="text"
          fullWidth
          value={name}
          onChange={(e) => setName(e.target.value)}
          helperText="The room is renamed for everyone in it."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!valid}>
          Rename
        </Button>
      </DialogActions>
    </Dialog>
  );
}

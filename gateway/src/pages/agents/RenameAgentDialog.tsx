import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { type AgentSummary, renameAgent } from "../../data/api";

// "notes-helper" -> "Notes Helper": the label a name usually reads as.
export function labelFromName(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Renames an agent and sets its display name in one step, from its page or
 * its row in the list. Its result, and anything the rename could not finish,
 * goes to `onRenamed` as lines for a notice. */
export default function RenameAgentDialog({
  open,
  agent,
  onClose,
  onRenamed,
}: {
  open: boolean;
  agent: Pick<AgentSummary, "id" | "name" | "display_name">;
  onClose: () => void;
  onRenamed: (lines: string[], severity: "success" | "warning") => void;
}) {
  const currentLabel = agent.display_name ?? "";
  // The label follows the name while it is still the name written out; once
  // someone edits it, or it was something else all along, it is left alone.
  const labelFollowsName =
    currentLabel !== "" && currentLabel === labelFromName(agent.name);
  const [name, setName] = useState(agent.name);
  const [displayName, setDisplayName] = useState(currentLabel);
  const [labelEdited, setLabelEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(agent.name);
      setDisplayName(agent.display_name ?? "");
      setLabelEdited(false);
      setError(null);
    }
  }, [open, agent.name, agent.display_name]);

  const trimmed = name.trim();
  const trimmedLabel = displayName.trim();
  const unchanged = trimmed === agent.name && trimmedLabel === currentLabel;
  const suggested = labelFollowsName && !labelEdited && trimmed !== agent.name;

  const changeName = (value: string) => {
    setName(value);
    if (labelFollowsName && !labelEdited) {
      setDisplayName(labelFromName(value.trim()));
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await renameAgent(agent.id, trimmed, trimmedLabel || null);
      const label = result.agent.display_name;
      const lines =
        result.old_name === result.agent.name
          ? [`Display name is now ${label ? `"${label}"` : "cleared"}.`]
          : [
              `Renamed "${result.old_name}" to "${result.agent.name}"` +
                (label ? `, shown as "${label}".` : "."),
            ];
      if (result.bridge_failures.length > 0) {
        lines.push(
          `Not yet updated on: ${result.bridge_failures.join("; ")}. ` +
            "It catches up when that bridge next starts.",
        );
      }
      if (result.templates_mentioning_old_name.length > 0) {
        lines.push(
          "These saved templates still use the old name: " +
            result.templates_mentioning_old_name.join(", ") +
            ".",
        );
      }
      const clean =
        result.bridge_failures.length === 0 &&
        result.templates_mentioning_old_name.length === 0;
      onRenamed(lines, clean ? "success" : "warning");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !unchanged && trimmed && !saving) void submit();
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename agent</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          The name is what people type to mention the agent; the display name is
          what they read. Its rooms, roles and history stay with it, and
          connected chat platforms are updated too.
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={name}
            onChange={(e) => changeName(e.target.value)}
            onKeyDown={submitOnEnter}
            helperText="Lowercase letters, digits, dots, hyphens and underscores."
            inputProps={{ "aria-label": "New name" }}
          />
          <TextField
            fullWidth
            label="Display name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setLabelEdited(true);
            }}
            onKeyDown={submitOnEnter}
            helperText={
              suggested
                ? "Suggested from the new name. Change it if you like."
                : "Leave blank to show the name instead."
            }
            inputProps={{ "aria-label": "Display name" }}
          />
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={saving || unchanged || !trimmed}
        >
          {saving ? "Saving…" : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

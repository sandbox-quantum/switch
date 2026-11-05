import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import type { DeleteAgentResult } from "../../../data/api";
import {
  fetchCloudAgentRunning,
  refusalText,
  restartCloudAgent,
  setCloudAgentDisplayName,
  setCloudAgentRunning,
} from "../../../data/cloudAgentActions";
import CloudDeleteDialog from "./CloudDeleteDialog";

/**
 * Start, stop, restart and delete for an agent on the person's cloud box.
 * Delete opens the cloud delete, which minds the box's login.
 */
export function CloudAgentSection({
  agent,
  controllerId,
  onDeleted,
}: {
  agent: { id: string; name: string };
  /** The box's controller, from hosted-machines' `controller_id`. */
  controllerId: string;
  onDeleted: (result: DeleteAgentResult) => void;
}) {
  const [running, setRunning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const read = useCallback(async () => {
    try {
      setRunning(await fetchCloudAgentRunning(agent.id));
    } catch {
      setRunning(null);
    }
  }, [agent.id]);

  useEffect(() => {
    void read();
  }, [read]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(refusalText(error));
    } finally {
      setBusy(false);
      await read();
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={1}>
        <Typography variant="h6">Switch cloud</Typography>
        {running !== null && (
          <Chip
            size="small"
            label={running ? "Running" : "Stopped"}
            color={running ? "primary" : "default"}
          />
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2}>
        This agent runs on your cloud.
      </Typography>
      <Stack direction="row" spacing={1}>
        {running === false ? (
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => void act(() => setCloudAgentRunning(agent.id, true))}
          >
            Start
          </Button>
        ) : (
          <Button
            variant="outlined"
            disabled={busy || running === null}
            onClick={() => void act(() => setCloudAgentRunning(agent.id, false))}
          >
            Stop
          </Button>
        )}
        <Button
          variant="outlined"
          disabled={busy || running !== true}
          onClick={() => void act(() => restartCloudAgent(agent.id))}
        >
          Restart
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={busy}
          onClick={() => setDeleting(true)}
        >
          Delete
        </Button>
      </Stack>
      {problem && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {problem}
        </Alert>
      )}
      <CloudDeleteDialog
        agent={deleting ? agent : null}
        controllerId={controllerId}
        onClose={() => setDeleting(false)}
        onDeleted={(result) => {
          setDeleting(false);
          onDeleted(result);
        }}
      />
    </Box>
  );
}

/**
 * Renames a cloud agent by its display name only. Its name stays, since on
 * the box it is the agent's folder and the file explorer's key.
 */
export function CloudRenameDialog({
  open,
  agentId,
  name,
  displayName,
  onClose,
  onRenamed,
}: {
  open: boolean;
  agentId: string;
  name: string;
  displayName: string | null;
  onClose: () => void;
  onRenamed: (line: string) => void;
}) {
  const [value, setValue] = useState(displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(displayName ?? "");
      setProblem(null);
    }
  }, [open, displayName]);
  const unchanged = value.trim() === (displayName ?? "");

  const submit = async () => {
    setSaving(true);
    setProblem(null);
    try {
      await setCloudAgentDisplayName(agentId, value);
      const label = value.trim();
      onRenamed(label ? `Display name is now "${label}".` : "Display name cleared.");
    } catch (error) {
      setProblem(refusalText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename agent</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          This agent runs on your cloud, so its name stays as it is: it's the
          agent's folder there. Change the display name people see instead.
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            fullWidth
            label="Name"
            value={name}
            disabled
            inputProps={{ "aria-label": "Name" }}
          />
          <TextField
            autoFocus
            fullWidth
            label="Display name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !unchanged && !saving) void submit();
            }}
            helperText="Leave blank to show the name instead."
            inputProps={{ "aria-label": "Display name" }}
          />
        </Stack>
        {problem && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {problem}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={saving || unchanged}
          onClick={() => void submit()}
        >
          {saving ? "Saving…" : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

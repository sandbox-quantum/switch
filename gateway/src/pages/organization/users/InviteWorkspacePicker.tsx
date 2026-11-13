import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import type { OrganizationWorkspace } from "../../../data/api";

/** Which of the organization's workspaces an invite link is for, before the
 * link itself is made (`CreateInvitationDialog`): a link brings someone into
 * one workspace, as the role picked there. Archived workspaces are not
 * offered, as nobody can join one. Starts on the workspace the session is
 * in, when it is one of them. */
export default function InviteWorkspacePicker({
  workspaces,
  currentId,
  onPick,
  onClose,
}: {
  workspaces: readonly OrganizationWorkspace[];
  currentId: string | null;
  onPick: (workspace: OrganizationWorkspace) => void;
  onClose: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.some((w) => w.id === currentId) ? (currentId ?? "") : "",
  );
  const titleId = useId();
  const picked = workspaces.find((w) => w.id === workspaceId);

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Invite users</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          An invite link brings people into one workspace. Org admin is given to someone already
          in the organization, from their row.
        </Typography>
        <TextField
          select
          label="Workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          fullWidth
          autoFocus
        >
          {workspaces.map((w) => (
            <MenuItem key={w.id} value={w.id}>
              {w.name}
            </MenuItem>
          ))}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={picked === undefined}
          onClick={() => picked !== undefined && onPick(picked)}
        >
          Next
        </Button>
      </DialogActions>
    </Dialog>
  );
}

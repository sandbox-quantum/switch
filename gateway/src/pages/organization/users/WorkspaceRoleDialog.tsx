import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import {
  type OrganizationMemberEntry,
  type TenantRole,
  addToOrganizationWorkspace,
  changeOrganizationWorkspaceRole,
} from "../../../data/api";
import { WORKSPACE_ROLES, workspaceRoleLabel } from "../../workspace/roles";

interface Props {
  /** Add them to a workspace they are not in, or change their role in one
   * they are. */
  mode: "add" | "change";
  member: OrganizationMemberEntry;
  /** The workspaces to choose from: for adding, those of the organization
   * not archived and that they are not in; for changing, theirs. */
  workspaces: readonly { id: string; name: string }[];
  /** After the change went through, with what to tell the admin. */
  onDone: (notice: string) => Promise<void>;
  onClose: () => void;
}

/** One person, one of the organization's workspaces, and their role there.
 * Organization admin is not offered: it is granted on the person's row, and
 * comes with every workspace. Mounted only while open. */
export default function WorkspaceRoleDialog({ mode, member, workspaces, onDone, onClose }: Props) {
  const held = (id: string) => member.workspaces.find((w) => w.id === id);
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0].id : "");
  const [role, setRole] = useState<TenantRole | "">(
    mode === "change" && workspaces.length === 1 ? (held(workspaces[0].id)?.role ?? "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const current = mode === "change" && workspaceId !== "" ? held(workspaceId)?.role : undefined;

  const pick = (id: string) => {
    setWorkspaceId(id);
    if (mode === "change") setRole(held(id)?.role ?? "");
  };

  const save = async () => {
    if (workspace === undefined || role === "") return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "add") {
        await addToOrganizationWorkspace(workspace.id, member.user_id, role);
        await onDone(`Added ${member.name} to ${workspace.name} as ${workspaceRoleLabel(role)}.`);
      } else {
        await changeOrganizationWorkspaceRole(workspace.id, member.user_id, role);
        await onDone(`${member.name} is now ${workspaceRoleLabel(role)} of ${workspace.name}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: 0.5 }}>
        {mode === "add" ? "Add to a workspace" : "Change role in a workspace"}
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {member.name}
        </Typography>
        {workspaces.length === 0 ? (
          <Alert severity="info">
            {mode === "add"
              ? `${member.name} is already in every workspace that isn't archived.`
              : `${member.name} is in no workspace.`}
          </Alert>
        ) : (
          <Stack spacing={2}>
            <TextField
              select
              label="Workspace"
              value={workspaceId}
              onChange={(e) => pick(e.target.value)}
              fullWidth
            >
              {workspaces.map((w) => (
                <MenuItem key={w.id} value={w.id}>
                  {w.name}
                </MenuItem>
              ))}
            </TextField>
            <RadioGroup
              aria-label={`Role for ${member.email}`}
              value={role}
              onChange={(e) => setRole(e.target.value as TenantRole)}
            >
              <Stack spacing={1}>
                {WORKSPACE_ROLES.map((option) => {
                  const selected = option.role === role;
                  return (
                    <Box
                      key={option.role}
                      component="label"
                      sx={{
                        display: "flex",
                        gap: 1,
                        alignItems: "flex-start",
                        p: 1.5,
                        borderRadius: "12px",
                        cursor: "pointer",
                        border: "1px solid",
                        borderColor: selected ? "var(--sw-foreground)" : "var(--sw-border)",
                        backgroundColor: selected ? "var(--sw-muted)" : "transparent",
                      }}
                    >
                      <Radio value={option.role} size="small" sx={{ p: 0.25, mt: "1px" }} />
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {option.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.description}
                        </Typography>
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            </RadioGroup>
          </Stack>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={save}
          loading={busy}
          disabled={workspace === undefined || role === "" || role === current}
        >
          {mode === "add" ? "Add" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

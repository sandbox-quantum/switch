import { Alert, CircularProgress, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import {
  type OrganizationMemberEntry,
  type RemovalHeir,
  previewOrganizationWorkspaceRemoval,
  removeFromOrganizationWorkspace,
} from "../../../data/api";
import { removalDescription, removalNotice } from "../../workspace/memberRemoval";

interface Props {
  member: OrganizationMemberEntry;
  selfId: string;
  /** After the removal went through: what passed to whom, and the sign-ins
   * it could not revoke, as the server reported them. */
  onRemoved: (notice: string, warning: string | null) => Promise<void>;
  onClose: () => void;
}

/** Removing someone from one of the workspaces they are in, from the
 * organization: which one, then what goes with them and to whom, as the
 * server would hand it over now. Someone who still owns agents there is
 * refused by the server, which names them; that is shown as it says it.
 * Mounted only while open. */
export default function RemoveFromWorkspaceDialog({ member, selfId, onRemoved, onClose }: Props) {
  const choices = member.workspaces;
  const [workspaceId, setWorkspaceId] = useState(choices.length === 1 ? choices[0].id : "");
  const [heir, setHeir] = useState<{ for: string; heir: RemovalHeir | null } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const workspace = choices.find((w) => w.id === workspaceId);

  useEffect(() => {
    if (workspaceId === "") return;
    let current = true;
    setHeir(null);
    setPreviewError(null);
    previewOrganizationWorkspaceRemoval(workspaceId, member.user_id).then(
      (preview) => current && setHeir({ for: workspaceId, heir: preview.handed_over_to }),
      (err: unknown) =>
        current && setPreviewError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, member.user_id]);

  const previewed = heir !== null && heir.for === workspaceId;
  const remove = async () => {
    if (workspace === undefined) return;
    const result = await removeFromOrganizationWorkspace(workspace.id, member.user_id);
    await onRemoved(
      removalNotice(member, result, selfId, workspace.name),
      result.warning,
    );
  };

  return (
    <ConfirmDialog
      open
      title={member.user_id === selfId ? "Leave a workspace" : `Remove ${member.name} from a workspace`}
      description={
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            select
            label="Workspace"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            fullWidth
          >
            {choices.map((w) => (
              <MenuItem key={w.id} value={w.id}>
                {w.name}
              </MenuItem>
            ))}
          </TextField>
          {workspaceId === "" ? null : previewError !== null ? (
            <Alert severity="warning">
              Couldn't check who would receive what {member.user_id === selfId ? "you own" : "they own"}{" "}
              there: {previewError}
            </Alert>
          ) : previewed ? (
            <Typography variant="body2">
              {removalDescription(member, heir.heir, selfId, workspace?.name ?? null)}
            </Typography>
          ) : (
            <CircularProgress size={20} aria-label="Checking what they own" />
          )}
        </Stack>
      }
      confirmLabel={member.user_id === selfId ? "Leave workspace" : "Remove"}
      tone="destructive"
      confirmDisabled={workspace === undefined || !previewed}
      onConfirm={remove}
      onClose={onClose}
    />
  );
}

import { Alert, CircularProgress, Link, Stack, Typography } from "@mui/material";
import { useCallback } from "react";
import { Link as RouterLink } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import { type Member, loadAgents, previewMemberRemoval } from "../../data/api";
import { removalDescription } from "./memberRemoval";
import { useLoad } from "./useLoad";

interface Props {
  tenantId: string;
  member: Member;
  workspaceName: string;
  selfId: string;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

/** Removing someone, or leaving: what goes with them, and to whom, as the
 * server would hand it over now. An agent stays with its owner rather than
 * going with them, so someone who still owns any is sent to each one first,
 * where it can be handed over or deleted. The server checks again when asked,
 * and whatever else it refuses is shown as it says it. Mounted only while
 * open, so both are read as it opens. */
export default function RemoveMemberDialog({
  tenantId,
  member,
  workspaceName,
  selfId,
  onRemove,
  onClose,
}: Props) {
  const leaving = member.user_id === selfId;
  const agents = useLoad(loadAgents);
  const loadPreview = useCallback(
    () => previewMemberRemoval(tenantId, member.user_id),
    [tenantId, member.user_id],
  );
  const preview = useLoad(loadPreview);
  const owned = (agents.data ?? []).filter((agent) => agent.owner_id === member.user_id);

  let description;
  if (agents.loading || preview.loading) {
    description = <CircularProgress size={20} aria-label="Checking what they own" />;
  } else if (owned.length > 0) {
    description = (
      <Stack spacing={1}>
        <Typography variant="body2">
          {leaving ? "You still own" : `${member.name} still owns`}{" "}
          {owned.length === 1 ? "an agent" : `${owned.length} agents`} here. Transfer or
          delete {owned.length === 1 ? "it" : "them"} first:
        </Typography>
        <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
          {owned.map((agent) => (
            <li key={agent.id}>
              <Link component={RouterLink} to={`/agents/${encodeURIComponent(agent.id)}`}>
                {agent.display_name ?? agent.name}
              </Link>
              {!agent.can_transfer && agent.transfer_blocked_reason !== null && (
                <Typography variant="caption" color="text.secondary" component="div">
                  {agent.transfer_blocked_reason}
                </Typography>
              )}
            </li>
          ))}
        </Stack>
      </Stack>
    );
  } else {
    description = (
      <Stack spacing={1.5}>
        {agents.error !== null && (
          <Alert severity="warning">
            Couldn't check which agents {leaving ? "you own" : "they own"}: {agents.error}.
            Removing still fails if any are left.
          </Alert>
        )}
        {preview.data !== null ? (
          <Typography variant="body2">
            {removalDescription(member, preview.data.handed_over_to, selfId, null)}
          </Typography>
        ) : (
          <Alert severity="warning">
            Couldn't check who would receive what {leaving ? "you own" : "they own"}:{" "}
            {preview.error}
          </Alert>
        )}
      </Stack>
    );
  }

  return (
    <ConfirmDialog
      open
      title={leaving ? `Leave ${workspaceName}?` : `Remove ${member.name}?`}
      description={description}
      confirmLabel={leaving ? "Leave workspace" : "Remove"}
      tone="destructive"
      confirmDisabled={agents.loading || preview.loading || owned.length > 0}
      onConfirm={onRemove}
      onClose={onClose}
    />
  );
}

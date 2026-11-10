import { Alert, CircularProgress, Link, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import { type Member, loadAgents } from "../../data/api";
import { useLoad } from "./useLoad";

interface Props {
  member: Member;
  workspaceName: string;
  /** Their own row: they are leaving rather than being removed. */
  leaving: boolean;
  /** Whether the person removing them has a membership here, so takes over
   * what they own (`removal_heir`); otherwise another admin does. */
  removerIsMember: boolean;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

/** Removing someone, or leaving: what goes with them, and what the server
 * will refuse. An agent stays with its owner rather than going with them, so
 * someone who still owns any is sent to each one first, where it can be
 * handed over or deleted. The server checks again when asked, and whatever
 * else it refuses is shown as it says it. Mounted only while open, so the
 * agents are read as it opens. */
export default function RemoveMemberDialog({
  member,
  workspaceName,
  leaving,
  removerIsMember,
  onRemove,
  onClose,
}: Props) {
  const agents = useLoad(loadAgents);
  const owned = (agents.data ?? []).filter((agent) => agent.owner_id === member.user_id);
  const heir = removerIsMember && !leaving ? "you" : "another admin of the workspace";

  let description;
  if (agents.loading) {
    description = <CircularProgress size={20} aria-label="Checking their agents" />;
  } else if (agents.error !== null) {
    description = (
      <Alert severity="warning">
        Couldn't check which agents {leaving ? "you own" : "they own"}: {agents.error}. Switch
        still refuses if any are left.
      </Alert>
    );
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
      <Typography variant="body2">
        {leaving ? "You lose" : `${member.name} loses`} access to {workspaceName} at once.{" "}
        {leaving ? "Your" : "Their"} API keys and connectors here stop working, and the rooms,
        templates and library items {leaving ? "you" : "they"} own pass to {heir}.
        {leaving
          ? " You'd need a new invitation to come back."
          : " Inviting them again brings them back, without what they owned."}
      </Typography>
    );
  }

  return (
    <ConfirmDialog
      open
      title={leaving ? `Leave ${workspaceName}?` : `Remove ${member.name}?`}
      description={description}
      confirmLabel={leaving ? "Leave workspace" : "Remove"}
      tone="destructive"
      confirmDisabled={agents.loading || owned.length > 0}
      onConfirm={onRemove}
      onClose={onClose}
    />
  );
}

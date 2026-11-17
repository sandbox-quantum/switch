import {
  Alert,
  Button,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { type OperatorWorkspace, fetchOperatorWorkspaces } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import OrganizationsWithoutWorkspace from "../account/OrganizationsWithoutWorkspace";
import { inviteTokenFrom, storePendingInvite } from "../../data/sessionState";
import CenteredCard from "./CenteredCard";
import CreateWorkspaceForm from "./CreateWorkspaceForm";

/** Signed in, and in no workspace yet. */
export default function OnboardingPage() {
  const { session, refresh } = useAuth();
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const canCreate = session?.can_create_workspace ?? false;

  const joinWithInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = inviteTokenFrom(invite);
    if (token === null) {
      setInviteError("That doesn't look like an invite link.");
      return;
    }
    storePendingInvite(token);
    // The pending invite now outranks this screen; re-reading the session
    // re-renders the app into the accept step.
    await refresh();
  };

  return (
    <CenteredCard
      title="Welcome to Switch"
      subtitle={
        canCreate
          ? "Create an organization for your team, or join a workspace you've been invited to."
          : "You're not in a workspace yet. Ask a workspace admin for an invite link."
      }
    >
      <Stack spacing={3}>
        <OrganizationsWithoutWorkspace />
        {session?.user.is_operator && <OperatorWorkspaces />}
        {session?.user.is_operator && <Divider>or</Divider>}
        {canCreate && <CreateWorkspaceForm />}
        {canCreate && <Divider>or</Divider>}
        <Stack component="form" onSubmit={joinWithInvite} spacing={2}>
          <Typography variant="subtitle2">Have an invite link?</Typography>
          {inviteError && <Alert severity="error">{inviteError}</Alert>}
          <TextField
            label="Invite link"
            value={invite}
            onChange={(e) => {
              setInvite(e.target.value);
              setInviteError(null);
            }}
            size="small"
          />
          <Button type="submit" variant="outlined" disabled={invite.trim() === ""}>
            Join with invite
          </Button>
        </Stack>
      </Stack>
    </CenteredCard>
  );
}

/** A platform operator in no workspace of their own, as one the operator adds
 * starts, opens any workspace on the operator flag, which is how they reach
 * the Platform pages. */
function OperatorWorkspaces() {
  const { switchTo } = useAuth();
  const [workspaces, setWorkspaces] = useState<OperatorWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetchOperatorWorkspaces().then(
      (found) => setWorkspaces(found.filter((w) => w.archived_at === null)),
      (err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load the workspaces"),
    );
  }, []);

  const open = async (tenantId: string) => {
    setPending(tenantId);
    setError(null);
    try {
      await switchTo(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that workspace");
      setPending(null);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Open a workspace as the platform operator</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {workspaces === null ? (
        error === null && <CircularProgress size={20} />
      ) : workspaces.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          There are no workspaces here yet.
        </Typography>
      ) : (
        <List disablePadding dense>
          {workspaces.map((workspace) => (
            <ListItemButton
              key={workspace.id}
              onClick={() => open(workspace.id)}
              disabled={pending !== null}
              sx={{ borderRadius: 1 }}
            >
              <ListItemText primary={workspace.name} secondary={workspace.organization_name} />
            </ListItemButton>
          ))}
        </List>
      )}
    </Stack>
  );
}

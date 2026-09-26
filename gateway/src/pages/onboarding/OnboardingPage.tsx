import { Alert, Button, Divider, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
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
          ? "Create a workspace for your team, or join one you've been invited to."
          : "You're not in a workspace yet. Ask a workspace admin for an invite link."
      }
    >
      <Stack spacing={3}>
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

import { Alert, Button, Divider, Stack, TextField } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { inviteTokenFrom, storePendingInvite } from "../../data/sessionState";
import AuthLayout, { SignedInFooter } from "../auth/AuthLayout";
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
    <AuthLayout
      title="Welcome to Switch"
      subtitle={
        canCreate
          ? "Create an organization for your team, or join a workspace you've been invited to."
          : "You're not in a workspace yet. Ask a workspace admin for an invite link."
      }
      footer={<SignedInFooter />}
    >
      <Stack spacing={3}>
        {canCreate && <CreateWorkspaceForm />}
        {canCreate && (
          <Divider sx={{ typography: "caption", color: "text.secondary" }}>or</Divider>
        )}
        <Stack component="form" onSubmit={joinWithInvite} spacing={2}>
          {inviteError && <Alert severity="error">{inviteError}</Alert>}
          <TextField
            label="Invite link"
            value={invite}
            onChange={(e) => {
              setInvite(e.target.value);
              setInviteError(null);
            }}
            helperText="Paste the link from your invitation."
          />
          <Button type="submit" variant="outlined" fullWidth disabled={invite.trim() === ""}>
            Join with invite
          </Button>
        </Stack>
      </Stack>
    </AuthLayout>
  );
}

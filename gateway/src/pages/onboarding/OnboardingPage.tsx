import { Alert, Button, Divider, Stack, TextField } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { oidcLoginUrl } from "../../data/api";
import OrganizationsWithoutWorkspace from "../account/OrganizationsWithoutWorkspace";
import { inviteTokenFrom, storePendingInvite } from "../../data/sessionState";
import AuthLayout, { SignedInFooter } from "../auth/AuthLayout";
import CreateWorkspaceForm from "./CreateWorkspaceForm";
import LicenseStep from "./LicenseStep";
import OnboardingSteps, { LICENSE_ACCEPTED_KEY, ONBOARDING_STEPS } from "./OnboardingSteps";
import OrganizationSetupForm from "./OrganizationSetupForm";

/** Joining a workspace with the link from an invitation. */
function JoinWithInvite() {
  const { refresh } = useAuth();
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

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
  );
}

/** Where organizations are kept in the account every Switch product shares:
 * the license first where one is asked, then the organization, set up the
 * way Switch Trust sets one up. Someone who may not create one is told they
 * aren't in one yet, and how to get into one. */
function DirectoryOnboarding() {
  const { session } = useAuth();
  const canCreate = session?.can_create_workspace ?? false;
  const license = session?.license_to_accept ?? null;

  if (!canCreate) {
    return (
      <AuthLayout
        title="You're not in an organization yet"
        subtitle="Ask an admin of your organization to invite you. If you've just been invited or added, sign in again to pick it up."
        footer={<SignedInFooter />}
      >
        <Stack spacing={3}>
          <OrganizationsWithoutWorkspace />
          <Button variant="contained" fullWidth href={oidcLoginUrl(null, "/")}>
            Sign in again
          </Button>
          <Divider sx={{ typography: "caption", color: "text.secondary" }}>or</Divider>
          <JoinWithInvite />
        </Stack>
      </AuthLayout>
    );
  }
  if (license !== null) return <LicenseStep version={license} />;
  return (
    <AuthLayout
      title="Welcome to Switch Rooms!"
      subtitle="Set up your organization to get started."
      footer={<SignedInFooter />}
    >
      <Stack spacing={3}>
        {licenseAcceptedHere() && (
          <OnboardingSteps current={1} steps={ONBOARDING_STEPS} />
        )}
        <OrganizationsWithoutWorkspace />
        <OrganizationSetupForm />
        <Divider sx={{ typography: "caption", color: "text.secondary" }}>
          or join one you've been invited to
        </Divider>
        <JoinWithInvite />
      </Stack>
    </AuthLayout>
  );
}

/** Whether the license was accepted in this browser tab just now, so the
 * organization step shows as the second of two (`LicenseStep` notes it). */
function licenseAcceptedHere(): boolean {
  return window.sessionStorage.getItem(LICENSE_ACCEPTED_KEY) !== null;
}

/** Signed in, and in no workspace yet. */
export default function OnboardingPage() {
  const { session } = useAuth();
  const canCreate = session?.can_create_workspace ?? false;

  if (session?.organizations_in_directory) return <DirectoryOnboarding />;
  const license = session?.license_to_accept ?? null;
  if (canCreate && license !== null) return <LicenseStep version={license} />;

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
        <OrganizationsWithoutWorkspace />
        {canCreate && <CreateWorkspaceForm />}
        {canCreate && (
          <Divider sx={{ typography: "caption", color: "text.secondary" }}>or</Divider>
        )}
        <JoinWithInvite />
      </Stack>
    </AuthLayout>
  );
}

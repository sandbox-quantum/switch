import { Alert, Button, CircularProgress, Stack } from "@mui/material";
import { useState } from "react";
import { acceptInvitation } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { clearPendingInvite } from "../../data/sessionState";
import AuthLayout, { SignedInFooter } from "../auth/AuthLayout";

/** A signed-in person arriving with an invite token. The token names the
 * workspace, but only the server can read it, so what they are joining is
 * shown once they accept. */
export default function AcceptInvitePage({ token }: { token: string }) {
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Accepting switches the session into the workspace, so success reloads
  // into it. Either way the token is spent from this tab: a failed one will
  // not succeed on a retry, and should not keep this screen in front of
  // everything else.
  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvitation(token);
      clearPendingInvite();
      window.location.assign("/");
    } catch (err) {
      clearPendingInvite();
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
      setSubmitting(false);
    }
  };

  const decline = async () => {
    clearPendingInvite();
    await refresh();
  };

  return (
    <AuthLayout
      title="Join a workspace"
      subtitle="You've been invited to a Switch workspace. Accept to open it."
      footer={<SignedInFooter />}
    >
      {error ? (
        <Stack spacing={2}>
          <Alert severity="error">{error}</Alert>
          <Button variant="outlined" fullWidth onClick={decline}>
            Continue
          </Button>
        </Stack>
      ) : (
        <Stack spacing={1}>
          <Button
            variant="contained"
            fullWidth
            onClick={accept}
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          >
            Accept invitation
          </Button>
          <Button variant="outlined" fullWidth onClick={decline} disabled={submitting}>
            Decline
          </Button>
        </Stack>
      )}
    </AuthLayout>
  );
}

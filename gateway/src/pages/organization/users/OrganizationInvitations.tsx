import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import {
  type OrganizationInvitation,
  fetchOrganizationInvitations,
  needsOrganizationSignIn,
  organizationSignInUrl,
  organizationToSignInTo,
  resendOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../../../data/api";

const ROLE_LABELS = { org_admin: "Org Admin", member: "Viewer" } as const;

/** The organization's pending invitations, as its account settings have
 * them, each to send again or revoke. Read again when `version` changes,
 * after an invitation is sent. */
export default function OrganizationInvitations({ version }: { version: number }) {
  const [invitations, setInvitations] = useState<OrganizationInvitation[] | null>(null);
  const [loadError, setLoadError] = useState<Failure | null>(null);
  // Only the latest read is kept: two in flight can answer out of order.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const read = await fetchOrganizationInvitations();
      if (mine !== latest.current) return;
      setInvitations(read);
      setLoadError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      setLoadError(failure(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<OrganizationInvitation | null>(null);

  const act = async (invitation: OrganizationInvitation, kind: "resend" | "revoke") => {
    setBusy(invitation.id);
    setError(null);
    setNotice(null);
    try {
      if (kind === "resend") {
        await resendOrganizationInvitation(invitation.id);
        setNotice(`Invitation sent to ${invitation.email} again.`);
      } else {
        await revokeOrganizationInvitation(invitation.id);
        setNotice(`Invitation to ${invitation.email} revoked.`);
        await reload();
      }
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(null);
    }
  };

  const pending = (invitations ?? []).filter((invitation) => invitation.state === "pending");
  const shown = error ?? loadError;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Pending invitations
      </Typography>
      <Stack spacing={1.5}>
        {shown !== null && (
          <Alert
            severity="error"
            onClose={error !== null ? () => setError(null) : undefined}
            action={
              shown.signInTo !== undefined && (
                <Button
                  color="inherit"
                  size="small"
                  href={organizationSignInUrl(window.location.pathname, shown.signInTo)}
                >
                  Sign in
                </Button>
              )
            }
          >
            {shown.message}
          </Alert>
        )}
        {notice !== null && (
          <Alert severity="success" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {invitations !== null && loadError === null && pending.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No invitations waiting to be accepted.
          </Typography>
        )}
        {pending.length > 0 && (
          <Table size="small" aria-label="Pending invitations">
            <TableHead>
              <TableRow>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {pending.map((invitation) => (
                <TableRow key={invitation.id} data-testid={`invitation-${invitation.id}`}>
                  <TableCell>{invitation.email}</TableCell>
                  <TableCell>
                    <Chip label={ROLE_LABELS[invitation.role]} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>{new Date(invitation.expires_at).toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      disabled={busy !== null}
                      onClick={() => void act(invitation, "resend")}
                    >
                      Resend
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      disabled={busy !== null}
                      onClick={() => setRevoking(invitation)}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>
      {revoking !== null && (
        <ConfirmDialog
          open
          title="Revoke invitation"
          description={`${revoking.email} can no longer use this invitation to join.`}
          confirmLabel="Revoke"
          tone="destructive"
          onConfirm={() => act(revoking, "revoke")}
          onClose={() => setRevoking(null)}
        />
      )}
    </Box>
  );
}

/** What went wrong, and, where the admin's sign-in to the organization's
 * account has to be done again, which organization to sign in to. */
type Failure = { message: string; signInTo?: string | null };

function failure(err: unknown): Failure {
  const message = err instanceof Error ? err.message : "The request failed";
  return needsOrganizationSignIn(err) ? { message, signInTo: organizationToSignInTo(err) } : { message };
}

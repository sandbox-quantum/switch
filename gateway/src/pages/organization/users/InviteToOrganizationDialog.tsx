import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useState } from "react";
import {
  type OrganizationInvitation,
  type OrganizationRole,
  inviteToOrganization,
  needsOrganizationSignIn,
  organizationSignInUrl,
  organizationToSignInTo,
} from "../../../data/api";

/** The same words as making someone Org Admin on the members page. */
export const ORG_ADMIN_BILLING_WARNING =
  "This person also becomes Org Admin in Switch Trust, with billing permissions.";

const ROLES: { value: OrganizationRole; label: string; help: string }[] = [
  { value: "member", label: "Viewer", help: "Joins the organization and its workspace." },
  { value: "org_admin", label: "Org Admin", help: "Administers the organization and every workspace." },
];

/** Invite someone new to an organization whose members come from its account
 * settings: the invitation is made and e-mailed there, and accepting it signs
 * them in to the organization with the role picked here. What the account
 * settings refuse (a pending invitation, someone already in, a role above
 * yours) is shown in their words. */
export default function InviteToOrganizationDialog({
  organizationName,
  onInvited,
  onClose,
}: {
  organizationName: string;
  onInvited: (invitation: OrganizationInvitation) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInTo, setSignInTo] = useState<string | null | undefined>(undefined);

  const submit = async () => {
    if (role === "") return;
    setSubmitting(true);
    setError(null);
    setSignInTo(undefined);
    try {
      onInvited(await inviteToOrganization(email.trim(), role));
    } catch (err) {
      if (needsOrganizationSignIn(err)) setSignInTo(organizationToSignInTo(err));
      setError(err instanceof Error ? err.message : "The invitation failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Invite to {organizationName}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            fullWidth
          />
          <TextField
            select
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as OrganizationRole)}
            helperText={ROLES.find((r) => r.value === role)?.help ?? " "}
            required
            fullWidth
          >
            {ROLES.map((r) => (
              <MenuItem key={r.value} value={r.value}>
                {r.label}
              </MenuItem>
            ))}
          </TextField>
          {role === "org_admin" && <Alert severity="warning">{ORG_ADMIN_BILLING_WARNING}</Alert>}
          {error !== null && (
            <Alert
              severity="error"
              action={
                signInTo !== undefined && (
                  <Button
                    color="inherit"
                    size="small"
                    href={organizationSignInUrl(window.location.pathname, signInTo)}
                  >
                    Sign in
                  </Button>
                )
              }
            >
              {error}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={submitting || role === "" || email.trim() === ""}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Send invitation
        </Button>
      </DialogActions>
    </Dialog>
  );
}

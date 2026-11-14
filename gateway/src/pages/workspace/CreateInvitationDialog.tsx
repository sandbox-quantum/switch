import ContentCopy from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from "@mui/material";
import { useCallback, useState } from "react";
import { type TenantRole, createInvitation, inviteToOrganizationWorkspace } from "../../data/api";
import { type DeliveryNotice, deliveryNotice, inviteUrl } from "../../data/sessionState";
import { announceInvitationCreated } from "./invitationEvents";
import { WORKSPACE_ROLES, workspaceRoleLabel } from "./roles";

/** Mirrors `MAX_INVITATION_USES` in the server's invitation schema. */
const MAX_INVITATION_USES = 100;

/** How long a link lasts, in hours: all within the server's limit of a year. */
export const EXPIRY_CHOICES: readonly { hours: number; label: string }[] = [
  { hours: 24, label: "1 day" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
  { hours: 24 * 90, label: "90 days" },
];
const DEFAULT_EXPIRY_HOURS = 24 * 7;

interface Props {
  open: boolean;
  tenantId: string;
  /** Made from the organization's settings, for any of its workspaces, rather
   * than from the workspace the session is in. */
  fromOrganization: boolean;
  workspaceName: string;
  emailEnabled: boolean;
  onClose: () => void;
}

/** An invitation naming an address is e-mailed when the server has mail set
 * up; either way the token is returned once, at creation, so the link is
 * shown here and nowhere else — alongside what happened to the e-mail. The
 * role is picked, not defaulted: it is the one choice here that decides what
 * someone can do. */
export default function CreateInvitationDialog({
  open,
  tenantId,
  fromOrganization,
  workspaceName,
  emailEnabled,
  onClose,
}: Props) {
  const [role, setRole] = useState<TenantRole | "">("");
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState(DEFAULT_EXPIRY_HOURS);
  const [uses, setUses] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<DeliveryNotice | null>(null);
  const [copied, setCopied] = useState(false);

  const handleClose = useCallback(() => {
    setRole("");
    setEmail("");
    setHours(DEFAULT_EXPIRY_HOURS);
    setUses("1");
    setError(null);
    setLink(null);
    setNotice(null);
    setCopied(false);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (role === "") return;
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        role,
        email: email.trim() === "" ? null : email.trim(),
        expires_in_hours: hours,
        uses_remaining: Number(uses),
      };
      const created = fromOrganization
        ? await inviteToOrganizationWorkspace(tenantId, input)
        : await createInvitation(tenantId, input);
      setLink(inviteUrl(window.location.origin, created.token));
      setNotice(deliveryNotice(created.email_delivery, created.email));
      announceInvitationCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invitation");
    } finally {
      setSubmitting(false);
    }
  }, [tenantId, fromOrganization, role, email, hours, uses]);

  const copy = useCallback(async () => {
    if (link === null) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }, [link]);

  const addressed = email.trim() !== "";
  const usesValid =
    Number.isInteger(Number(uses)) && Number(uses) > 0 && Number(uses) <= MAX_INVITATION_USES;
  const valid = role !== "" && usesValid;

  return (
    // Held open while the link is being made: closed then, the link would be
    // created with nowhere to show it, and it is shown only once.
    <Dialog open={open} onClose={submitting ? undefined : handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Invite users to {workspaceName}</DialogTitle>
      <DialogContent>
        {link !== null && notice !== null ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity={notice.severity}>{notice.text}</Alert>
            <TextField
              value={link}
              label="Invite link"
              fullWidth
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title={copied ? "Copied" : "Copy"}>
                        <IconButton onClick={copy} edge="end" aria-label="Copy invite link">
                          <ContentCopy fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Stack>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              select
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as TenantRole)}
              helperText={`Workspace admin and Member are both scoped to ${workspaceName}.`}
              slotProps={{
                select: {
                  displayEmpty: true,
                  renderValue: (value) =>
                    value === "" ? "Select role" : workspaceRoleLabel(value as TenantRole),
                },
              }}
            >
              {WORKSPACE_ROLES.map((option) => (
                <MenuItem
                  key={option.role}
                  value={option.role}
                  sx={{ whiteSpace: "normal", maxWidth: 520 }}
                >
                  <ListItemText
                    primary={option.label}
                    secondary={option.description}
                    slotProps={{ secondary: { variant: "caption" } }}
                  />
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Email (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              helperText={
                emailEnabled
                  ? "We'll e-mail them the link. Only someone signed in with this address can accept. Leave empty for anyone with the link."
                  : "E-mail isn't set up here, so you'll get a link to send yourself. Only someone signed in with this address can accept. Leave empty for anyone with the link."
              }
            />
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Expires after"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                fullWidth
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <MenuItem key={choice.hours} value={choice.hours}>
                    {choice.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Uses"
                type="number"
                value={uses}
                onChange={(e) => setUses(e.target.value)}
                error={!usesValid}
                helperText={`Up to ${MAX_INVITATION_USES}`}
                fullWidth
              />
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {link !== null ? (
          <Button onClick={handleClose} variant="contained">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              variant="contained"
              disabled={submitting || !valid}
              startIcon={submitting ? <CircularProgress size={16} /> : undefined}
            >
              {emailEnabled && addressed ? "Send invitation" : "Create link"}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

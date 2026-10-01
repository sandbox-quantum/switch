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
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from "@mui/material";
import { useCallback, useState } from "react";
import { type TenantRole, createInvitation } from "../../data/api";
import { inviteUrl } from "../../data/sessionState";

interface Props {
  open: boolean;
  tenantId: string;
  isOwner: boolean;
  onClose: () => void;
  onCreated: () => void;
}

/** Invitations are shared as links, not emailed. The token is returned once,
 * at creation, so the link is shown here and nowhere else. */
export default function CreateInvitationDialog({
  open,
  tenantId,
  isOwner,
  onClose,
  onCreated,
}: Props) {
  const [role, setRole] = useState<TenantRole>("member");
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState("168");
  const [uses, setUses] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleClose = useCallback(() => {
    setRole("member");
    setEmail("");
    setHours("168");
    setUses("1");
    setError(null);
    setLink(null);
    setCopied(false);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await createInvitation(tenantId, {
        role,
        email: email.trim() === "" ? null : email.trim(),
        expires_in_hours: Number(hours),
        uses_remaining: Number(uses),
      });
      setLink(inviteUrl(window.location.origin, created.token));
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invitation");
    } finally {
      setSubmitting(false);
    }
  }, [tenantId, role, email, hours, uses, onCreated]);

  const copy = useCallback(async () => {
    if (link === null) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }, [link]);

  const roles: TenantRole[] = isOwner ? ["member", "admin", "owner"] : ["member", "admin"];
  const valid =
    Number.isInteger(Number(hours)) && Number(hours) > 0 && Number(hours) <= 8760 &&
    Number.isInteger(Number(uses)) && Number(uses) > 0;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Invite to workspace</DialogTitle>
      <DialogContent>
        {link !== null ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="success">
              Send this link to the person you are inviting. It is shown only once.
            </Alert>
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
            >
              {roles.map((r) => (
                <MenuItem key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Email (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              helperText="Only someone signed in with this address can accept. Leave empty for anyone with the link."
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Expires in (hours)"
                type="number"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                fullWidth
              />
              <TextField
                label="Uses"
                type="number"
                value={uses}
                onChange={(e) => setUses(e.target.value)}
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
            <Button onClick={handleClose}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              variant="contained"
              disabled={submitting || !valid}
              startIcon={submitting ? <CircularProgress size={16} /> : undefined}
            >
              Create link
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

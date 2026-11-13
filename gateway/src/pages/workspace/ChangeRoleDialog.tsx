import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import type { Member, TenantRole } from "../../data/api";
import { WORKSPACE_ROLES } from "./roles";

interface Props {
  member: Member;
  onSave: (role: TenantRole) => Promise<void>;
  onClose: () => void;
}

/** Pick a member's workspace role from the two the server takes, each with
 * what it lets them do. Organization admin is not offered: it is granted in
 * the organization's settings. Mounted only while open, so it starts from the
 * member's current role every time. */
export default function ChangeRoleDialog({ member, onSave, onClose }: Props) {
  const [role, setRole] = useState<TenantRole>(member.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(role);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8, pb: 0.5 }}>
        Change role
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {member.name}
        </Typography>
        <RadioGroup
          aria-label={`Role for ${member.email}`}
          value={role}
          onChange={(e) => setRole(e.target.value as TenantRole)}
        >
          <Stack spacing={1}>
            {WORKSPACE_ROLES.map((option) => {
              const selected = option.role === role;
              return (
                <Box
                  key={option.role}
                  component="label"
                  sx={{
                    display: "flex",
                    gap: 1,
                    alignItems: "flex-start",
                    p: 1.5,
                    borderRadius: "12px",
                    cursor: "pointer",
                    border: "1px solid",
                    borderColor: selected ? "var(--sw-foreground)" : "var(--sw-border)",
                    backgroundColor: selected ? "var(--sw-muted)" : "transparent",
                  }}
                >
                  <Radio
                    value={option.role}
                    size="small"
                    // Focus starts on their current role, the choice to move from.
                    autoFocus={option.role === member.role}
                    sx={{ p: 0.25, mt: "1px" }}
                  />
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {option.label}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {option.description}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Stack>
        </RadioGroup>
        {error && (
          <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} loading={busy} disabled={role === member.role}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

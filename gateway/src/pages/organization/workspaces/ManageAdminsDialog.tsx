import CloseOutlined from "@mui/icons-material/CloseOutlined";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useId, useState } from "react";
import { type OrganizationMemberEntry, fetchOrganizationMembers } from "../../../data/api";
import { useLoad } from "../../workspace/useLoad";

interface Candidate {
  id: string;
  name: string;
  email: string;
  /** Whether they hold the workspace admin role there already. */
  ticked: boolean;
}

/** Who may be made an admin of this workspace: its members who are not
 * already an org admin (an org admin administers every workspace already,
 * and isn't offered here), pre-ticked where their role there is "admin".
 * The registration service account is never offered: the server never makes
 * it an admin, and leaves it as it is. */
function candidatesFor(members: readonly OrganizationMemberEntry[], workspaceId: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const member of members) {
    if (member.role === "org_admin" || member.service_account) continue;
    const membership = member.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!membership) continue;
    candidates.push({
      id: member.user_id,
      name: member.name,
      email: member.email,
      ticked: membership.role === "admin",
    });
  }
  return candidates;
}

interface Props {
  workspace: { id: string; name: string };
  /** Saving the exact set of ids ticked. Left to throw: the dialog shows what
   * it says (the server refuses taking the last admin away, say) and stays
   * open. */
  onSave: (userIds: string[]) => Promise<void>;
  onClose: () => void;
}

/** Picks who administers one of the organization's workspaces, from its
 * members. Mounted only while open, so the roster and the ticks it starts
 * from are always current. */
export default function ManageAdminsDialog({ workspace, onSave, onClose }: Props) {
  const load = useCallback(() => fetchOrganizationMembers(), []);
  const { data: members, error, loading } = useLoad(load);
  // Only what someone has flipped from the server's answer; a candidate with
  // no entry here keeps `ticked` as the server has it. Avoids seeding state
  // from data that arrives after the first render.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleId = useId();

  const candidates = members ? candidatesFor(members, workspace.id) : [];
  const isTicked = (candidate: Candidate) => overrides[candidate.id] ?? candidate.ticked;
  const toggle = (candidate: Candidate) =>
    setOverrides((current) => ({ ...current, [candidate.id]: !isTicked(candidate) }));

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await onSave(candidates.filter(isTicked).map((candidate) => candidate.id));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
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
        Admins of {workspace.name}
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
          Who administers {workspace.name}. Org admins aren't listed — they administer every
          workspace already.
        </Typography>
        {loading ? (
          <CircularProgress size={24} aria-label={`Loading ${workspace.name}'s members`} />
        ) : error !== null ? (
          <Alert severity="error">{error}</Alert>
        ) : candidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nobody is in {workspace.name} yet. Invite people to it from Organization settings ›
            Users, then come back to pick an admin.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {candidates.map((candidate) => (
              <FormControlLabel
                key={candidate.id}
                sx={{ mx: 0, alignItems: "flex-start", py: 0.5 }}
                control={
                  <Checkbox
                    size="small"
                    checked={isTicked(candidate)}
                    onChange={() => toggle(candidate)}
                    sx={{ pt: 0 }}
                  />
                }
                label={
                  <Stack sx={{ lineHeight: 1.3 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {candidate.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {candidate.email}
                    </Typography>
                  </Stack>
                }
              />
            ))}
          </Stack>
        )}
        {saveError && (
          <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
            {saveError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} loading={busy} disabled={busy || candidates.length === 0}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

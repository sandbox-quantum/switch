import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useMemo, useState } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import {
  type Invitation,
  fetchCurrentOrganization,
  fetchInvitations,
  revokeInvitation,
} from "../../data/api";
import { formatDate, sentenceCase } from "../../theme/format";
import CreateInvitationDialog from "./CreateInvitationDialog";
import { useInvitationCreated } from "./invitationEvents";
import { useLoad } from "./useLoad";

function invitationStatus(inv: Invitation, now: number): string {
  if (inv.revoked_at) return "Revoked";
  if (new Date(inv.expires_at).getTime() <= now) return "Expired";
  if (inv.uses_remaining <= 0) return "Used";
  return "Active";
}

export default function InvitationsSection({
  tenantId,
  workspaceName,
  inOrganization,
  emailEnabled,
}: {
  tenantId: string;
  workspaceName: string;
  inOrganization: boolean;
  emailEnabled: boolean;
}) {
  const load = useCallback(() => fetchInvitations(tenantId), [tenantId]);
  const { data: invitations, error, loading, refetch } = useLoad(load);
  useInvitationCreated(refetch);
  // Whether only people already in the organization can accept: where its
  // members come from its account settings, Switch can't add anyone new.
  const loadOrganization = useCallback(
    () => (inOrganization ? fetchCurrentOrganization() : Promise.resolve(null)),
    [inOrganization],
  );
  const { data: organization, error: organizationError } = useLoad(loadOrganization);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Re-evaluated on a timer so an invitation that expires while the page is
  // open stops showing as active.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const revoke = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        await revokeInvitation(tenantId, id);
        await refetch();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not revoke the invitation");
      }
    },
    [refetch, tenantId],
  );

  const columns = useMemo<GridColDef<Invitation>[]>(() => {
    return [
      {
        field: "email",
        headerName: "For",
        flex: 1.5,
        minWidth: 180,
        valueFormatter: (value) => (value as string | null) ?? "Anyone with the link",
      },
      {
        field: "role",
        headerName: "Role",
        width: 110,
        valueFormatter: (value) => sentenceCase(String(value)),
      },
      {
        field: "status",
        headerName: "Status",
        width: 110,
        valueGetter: (_value, row) => invitationStatus(row, now),
        renderCell: ({ value }) => (
          <Chip label={value} size="small" color={value === "Active" ? "primary" : "default"} />
        ),
      },
      { field: "uses_remaining", headerName: "Uses left", width: 100 },
      {
        field: "expires_at",
        headerName: "Expires",
        width: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        renderCell: ({ row }) =>
          invitationStatus(row, now) === "Active" ? (
            <Button size="small" color="error" onClick={() => revoke(row.id)}>
              Revoke
            </Button>
          ) : null,
      },
    ];
  }, [now, revoke]);

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">Invitations</Typography>
        <Button
          variant="contained"
          startIcon={<AddCircleOutline />}
          onClick={() => setCreateOpen(true)}
        >
          Invite
        </Button>
      </Stack>
      {organization?.members_from_directory && (
        <Alert severity="info">
          This organization's users come from your organization's account settings, so only
          people already in the organization can accept an invitation. Add anyone new there
          first.
        </Alert>
      )}
      {organizationError && (
        <Alert severity="warning">
          Could not check who can accept an invitation here: {organizationError}
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={invitations ?? []}
          columns={columns}
          emptyState={
            <TableEmptyState title="No invitations">
              Invite someone to give them a link to join with.
            </TableEmptyState>
          }
          height={Math.min(520, 108 + Math.max(1, invitations?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
      <CreateInvitationDialog
        open={createOpen}
        tenantId={tenantId}
        workspaceName={workspaceName}
        emailEnabled={emailEnabled}
        onClose={() => setCreateOpen(false)}
      />
    </Stack>
  );
}

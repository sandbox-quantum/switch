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
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { type Invitation, fetchInvitations, revokeInvitation } from "../../data/api";
import { formatDate, titleCase } from "../../theme/hootFormat";
import CreateInvitationDialog from "./CreateInvitationDialog";
import { useLoad } from "./useLoad";

function invitationStatus(inv: Invitation, now: number): string {
  if (inv.revoked_at) return "Revoked";
  if (new Date(inv.expires_at).getTime() <= now) return "Expired";
  if (inv.uses_remaining <= 0) return "Used";
  return "Active";
}

export default function InvitationsSection({
  tenantId,
  isOwner,
}: {
  tenantId: string;
  isOwner: boolean;
}) {
  const load = useCallback(() => fetchInvitations(tenantId), [tenantId]);
  const { data: invitations, error, loading, refetch } = useLoad(load);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
    const now = Date.now();
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
        valueFormatter: (value) => titleCase(String(value)),
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
  }, [revoke]);

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
          height={Math.min(520, 108 + Math.max(1, invitations?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
      <CreateInvitationDialog
        open={createOpen}
        tenantId={tenantId}
        isOwner={isOwner}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
    </Stack>
  );
}

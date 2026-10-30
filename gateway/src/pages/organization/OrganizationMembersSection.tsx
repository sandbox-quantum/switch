import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import {
  type OrganizationMember,
  type OrganizationRole,
  fetchOrganizationMembers,
  removeOrganizationMember,
  updateOrganizationRole,
} from "../../data/api";
import { formatDate } from "../../theme/hootFormat";
import { useLoad } from "../workspace/useLoad";

type MemberRow = OrganizationMember & { id: string };

const ROLE_LABELS: Record<OrganizationRole, string> = {
  org_admin: "Org Admin",
  member: "Member",
};

/** Everyone in the organization, across its workspaces, and their role in it.
 * The server refuses demoting or removing the last organization admin, and
 * removing someone still in one of its workspaces, naming them; its message
 * is shown as is. Demoting or removing an admin also takes away their keys and
 * connections in workspaces they were in only as an admin; what could not be
 * revoked at a vendor comes back as a warning, shown too. */
export default function OrganizationMembersSection({
  selfId,
  asOperator,
}: {
  selfId: string;
  // The platform operator, who is no admin here, may manage the members only
  // while the organization has no admin left, to make one.
  asOperator: boolean;
}) {
  const load = useCallback(() => fetchOrganizationMembers(), []);
  const { data: members, error, errorStatus, loading, refetch } = useLoad(load);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { refresh } = useAuth();

  const act = useCallback(
    async (userId: string, action: () => Promise<{ warning: string | null }>) => {
      setBusy(userId);
      setActionError(null);
      setActionWarning(null);
      try {
        const { warning } = await action();
        setActionWarning(warning);
        await refetch();
        // Your own role decides what this page offers you.
        if (userId === selfId) await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [refetch, refresh, selfId],
  );

  const columns = useMemo<GridColDef<MemberRow>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 140,
        renderCell: ({ row }) => (row.user_id === selfId ? `${row.name} (you)` : row.name),
      },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: 200 },
      {
        field: "role",
        headerName: "Organization role",
        width: 170,
        renderCell: ({ row }) => (
          <Select
            size="small"
            value={row.role}
            disabled={busy !== null}
            onChange={(e) =>
              act(row.user_id, () =>
                updateOrganizationRole(row.user_id, e.target.value as OrganizationRole),
              )
            }
            aria-label={`Organization role for ${row.email}`}
            sx={{ fontSize: "0.875rem" }}
          >
            {(Object.keys(ROLE_LABELS) as OrganizationRole[]).map((role) => (
              <MenuItem key={role} value={role}>
                {ROLE_LABELS[role]}
              </MenuItem>
            ))}
          </Select>
        ),
      },
      {
        field: "created_at",
        headerName: "Joined",
        width: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 60,
        sortable: false,
        renderCell: ({ row }) =>
          row.user_id === selfId ? null : (
            <Tooltip title="Remove from organization">
              <span>
                <IconButton
                  size="small"
                  disabled={busy !== null}
                  onClick={() => act(row.user_id, () => removeOrganizationMember(row.user_id))}
                  aria-label={`Remove ${row.email} from the organization`}
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ),
      },
    ],
    [act, busy, selfId],
  );
  // The operator restores an admin and nothing more: removing a member is
  // refused to them, so there is nothing to offer.
  const shown = asOperator ? columns.filter((c) => c.field !== "actions") : columns;

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Members</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Organization admins administer every workspace in the organization. Someone is removed
        from each workspace before they can be removed from the organization.
      </Typography>
      {asOperator && errorStatus === 403 ? (
        <Alert severity="info">
          As platform operator you can manage this organization's members only while it has no
          admin, to make someone one.
        </Alert>
      ) : (
        error && <Alert severity="error">{error}</Alert>
      )}
      {asOperator && !error && !loading && (
        <Alert severity="warning">
          This organization has no admin. As platform operator you can make one of its members
          an admin; the change is recorded in its audit log, marked as yours.
        </Alert>
      )}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {actionWarning && (
        <Alert severity="warning" onClose={() => setActionWarning(null)}>
          {actionWarning}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : error ? null : (
        <DataTable
          rows={(members ?? []).map((m) => ({ ...m, id: m.user_id }))}
          columns={shown}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
    </Stack>
  );
}

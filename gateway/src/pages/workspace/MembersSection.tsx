import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Chip,
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
import {
  type Member,
  type TenantRole,
  fetchMembers,
  removeMember,
  updateMemberRole,
} from "../../data/api";
import { formatDate, titleCase } from "../../theme/hootFormat";
import { useLoad } from "./useLoad";

type MemberRow = Member & { id: string };

interface Props {
  tenantId: string;
  selfId: string;
  canAdmin: boolean;
  isOwner: boolean;
}

/** An admin may manage members and admins; only an owner may grant the owner
 * role or touch an existing owner. The server enforces the same, and refuses
 * the last owner — its message is shown as is. */
export default function MembersSection({ tenantId, selfId, canAdmin, isOwner }: Props) {
  const load = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const { data: members, error, loading, refetch } = useLoad(load);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(
    async (userId: string, action: () => Promise<unknown>) => {
      setBusy(userId);
      setActionError(null);
      try {
        await action();
        await refetch();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  const columns = useMemo<GridColDef<MemberRow>[]>(() => {
    const mayManage = (row: MemberRow) => canAdmin && (isOwner || row.role !== "owner");
    const roles: TenantRole[] = isOwner ? ["owner", "admin", "member"] : ["admin", "member"];
    return [
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
        headerName: "Role",
        width: 150,
        renderCell: ({ row }) =>
          mayManage(row) ? (
            <Select
              size="small"
              value={row.role}
              disabled={busy !== null}
              onChange={(e) =>
                act(row.user_id, () =>
                  updateMemberRole(tenantId, row.user_id, e.target.value as TenantRole),
                )
              }
              aria-label={`Role for ${row.email}`}
              sx={{ fontSize: "0.875rem" }}
            >
              {roles.map((role) => (
                <MenuItem key={role} value={role}>
                  {titleCase(role)}
                </MenuItem>
              ))}
            </Select>
          ) : (
            <Chip
              label={titleCase(row.role)}
              size="small"
              color={row.role === "member" ? "default" : "primary"}
            />
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
          mayManage(row) && row.user_id !== selfId ? (
            <Tooltip title="Remove from workspace">
              <span>
                <IconButton
                  size="small"
                  disabled={busy !== null}
                  onClick={() => act(row.user_id, () => removeMember(tenantId, row.user_id))}
                  aria-label={`Remove ${row.email}`}
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ];
  }, [act, busy, canAdmin, isOwner, selfId, tenantId]);

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Members</Typography>
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
          rows={(members ?? []).map((m) => ({ ...m, id: m.user_id }))}
          columns={columns}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
    </Stack>
  );
}

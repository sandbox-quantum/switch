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
import { useAuth } from "../../data/AuthContext";
import {
  type Member,
  type TenantRole,
  fetchMembers,
  removeMember,
  updateMemberRole,
} from "../../data/api";
import { formatDate, sentenceCase } from "../../theme/hootFormat";
import { useLoad } from "./useLoad";

type MemberRow = Member & { id: string };

interface Props {
  tenantId: string;
  selfId: string;
}

/** Each row offers what the server says the caller may do with it: an admin
 * may change and remove every member, other admins included, but not their
 * own row (another admin steps them down) and not an organization admin's,
 * whose role comes from the organization and is changed on its page. One
 * with no membership of their own here is listed "via the organization". The
 * server refuses to demote or remove the last admin when asked — its message
 * is shown as is. */
export default function MembersSection({ tenantId, selfId }: Props) {
  const load = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const { data: members, error, loading, refetch } = useLoad(load);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { refresh } = useAuth();

  const act = useCallback(
    async (userId: string, action: () => Promise<unknown>, leaving = false) => {
      setBusy(userId);
      setActionError(null);
      try {
        await action();
        if (leaving) {
          // The session is on another workspace now, or none, and the page
          // follows it rather than reading this one's members again.
          await refresh();
          return;
        }
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

  const columns = useMemo<GridColDef<MemberRow>[]>(() => {
    const roles: TenantRole[] = ["admin", "member"];
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
        width: 210,
        renderCell: ({ row }) =>
          row.can_change_role ? (
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
                  {sentenceCase(role)}
                </MenuItem>
              ))}
            </Select>
          ) : row.organization_role === "org_admin" ? (
            <Tooltip
              title={
                row.via_organization
                  ? "Administers this workspace through the organization. Change it in the organization's settings."
                  : "An organization admin, and so an admin of every workspace in it. Change it in the organization's settings."
              }
            >
              <Chip
                label={
                  row.via_organization
                    ? "Org admin, via organization"
                    : `${sentenceCase(row.role)} · Org admin`
                }
                size="small"
                color="primary"
                variant="outlined"
              />
            </Tooltip>
          ) : (
            <Chip
              label={sentenceCase(row.role)}
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
          row.can_remove ? (
            <Tooltip title={row.user_id === selfId ? "Leave workspace" : "Remove from workspace"}>
              <span>
                <IconButton
                  size="small"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      row.user_id,
                      () => removeMember(tenantId, row.user_id),
                      row.user_id === selfId,
                    )
                  }
                  aria-label={row.user_id === selfId ? "Leave this workspace" : `Remove ${row.email}`}
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ];
  }, [act, busy, selfId, tenantId]);

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Users</Typography>
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

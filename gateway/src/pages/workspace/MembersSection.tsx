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
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import {
  type Member,
  type RemovalHeir,
  type TenantRole,
  fetchMembers,
  previewMemberRemoval,
  removeMember,
  updateMemberRole,
} from "../../data/api";
import { formatDate, sentenceCase } from "../../theme/format";
import { removalDescription, removalNotice } from "./memberRemoval";
import { useLoad } from "./useLoad";

type MemberRow = Member & { id: string };

interface PendingRemoval {
  member: Member;
  heir: RemovalHeir | null;
}

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
 * is shown as is.
 *
 * Removing someone, or leaving, hands what they own here to another admin.
 * The confirmation names that admin beforehand, as the server would choose
 * them, and the page reports what passed afterwards, from the server's
 * response. */
export default function MembersSection({ tenantId, selfId }: Props) {
  const load = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const { data: members, error, loading, refetch } = useLoad(load);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Kept once the dialog closes, so its text holds while it fades out.
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { refresh } = useAuth();

  const changeRole = useCallback(
    async (userId: string, role: TenantRole) => {
      setBusy(userId);
      setActionError(null);
      try {
        await updateMemberRole(tenantId, userId, role);
        await refetch();
        // Your own role decides what this page offers you.
        if (userId === selfId) await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [refetch, refresh, selfId, tenantId],
  );

  const askToRemove = useCallback(
    async (member: Member) => {
      setBusy(member.user_id);
      setActionError(null);
      try {
        const preview = await previewMemberRemoval(tenantId, member.user_id);
        setPending({ member, heir: preview.handed_over_to });
        setConfirming(true);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not prepare the removal");
      } finally {
        setBusy(null);
      }
    },
    [tenantId],
  );

  const confirmRemoval = useCallback(async () => {
    if (pending === null) return;
    const { member } = pending;
    const result = await removeMember(tenantId, member.user_id);
    setNotice(removalNotice(member, result, selfId));
    setActionWarning(result.warning);
    if (member.user_id === selfId) {
      // The session is on another workspace now, or none, and the page
      // follows it rather than reading this one's members again.
      await refresh();
      return;
    }
    await refetch();
  }, [pending, refetch, refresh, selfId, tenantId]);

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
              onChange={(e) => changeRole(row.user_id, e.target.value as TenantRole)}
              // The name goes on the input: on the Select it labels nothing.
              inputProps={{ "aria-label": `Role for ${row.email}` }}
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
                  onClick={() => askToRemove(row)}
                  aria-label={row.user_id === selfId ? "Leave this workspace" : `Remove ${row.email}`}
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ];
  }, [askToRemove, busy, changeRole, selfId]);

  const leaving = pending?.member.user_id === selfId;

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Users</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {actionWarning && (
        <Alert severity="warning" onClose={() => setActionWarning(null)}>
          {actionWarning}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={(members ?? []).map((m) => ({ ...m, id: m.user_id }))}
          columns={columns}
          emptyState={<TableEmptyState title="No users in this workspace yet" />}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
      <ConfirmDialog
        open={confirming}
        title={leaving ? "Leave this workspace?" : `Remove ${pending?.member.name ?? ""}?`}
        description={pending ? removalDescription(pending.member, pending.heir, selfId) : undefined}
        confirmLabel={leaving ? "Leave" : "Remove"}
        tone="destructive"
        onConfirm={confirmRemoval}
        onClose={() => setConfirming(false)}
      />
    </Stack>
  );
}

import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Button,
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
import { useCallback, useMemo } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import { type OrganizationMember, type OrganizationRole, fetchOrganizationMembers } from "../../data/api";
import { formatDate } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";
import { useMemberChanges } from "./memberChanges";
import OrganizationUsersNotices from "./OrganizationUsersNotices";

type MemberRow = OrganizationMember & { id: string };

const ROLE_LABELS: Record<OrganizationRole, string> = {
  org_admin: "Org admin",
  member: "Member",
};

/** Everyone in the organization, across its workspaces, and their role in it.
 * Each row offers what the server says the caller may do with it: never their
 * own row, which another organization admin changes. The server refuses
 * demoting or removing the last organization admin, and removing someone
 * still in one of its workspaces, naming them; its message is shown as is. Demoting or removing an admin also takes away their keys and
 * connections in workspaces they were in only as an admin; what could not be
 * revoked at a vendor comes back as a warning, shown too. */
export default function OrganizationMembersSection({
  selfId,
  organizationId,
  asOperator,
  canManage,
  fromDirectory,
  directoryTakesChanges,
  onChanged,
}: {
  selfId: string;
  organizationId: string;
  // The platform operator, who is no admin here, may manage the members only
  // while the organization has no admin left, to make one.
  asOperator: boolean;
  // The server's `can_manage_members`: whether this person may list and
  // manage the members at all. The operator is not asked for them where not.
  canManage: boolean;
  // The members come from the organization's account settings: nobody can be
  // made Org Admin here, and what is taken away here comes back while those
  // settings still grant it.
  fromDirectory: boolean;
  // Changes made here are made in those account settings too, so they last
  // and Org Admin can be given here; the admin may first be sent to sign in
  // there, and the change is made on coming back.
  directoryTakesChanges: boolean;
  // Called after each change that went through.
  onChanged: () => void;
}) {
  const lockedOut = asOperator && !canManage;
  const load = useCallback(
    () => (lockedOut ? Promise.resolve(null) : fetchOrganizationMembers()),
    [lockedOut],
  );
  const { data: members, error, errorStatus, loading, refetch } = useLoad(load);
  const { act, busy, actionError, actionWarning, toFinish, finish, dismissError, dismissWarning } =
    useMemberChanges({ organizationId, selfId, asOperator, onChanged, reload: refetch });

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
        renderCell: ({ row }) =>
          row.can_change_role ? (
            <Select
              size="small"
              value={row.role}
              disabled={busy !== null}
              onChange={(e) =>
                act({ userId: row.user_id, role: e.target.value as OrganizationRole })
              }
              // The name goes on the input: on the Select it labels nothing.
              inputProps={{ "aria-label": `Organization role for ${row.email}` }}
              sx={{ fontSize: "0.875rem" }}
            >
              {(Object.keys(ROLE_LABELS) as OrganizationRole[]).map((role) => (
                <MenuItem
                  key={role}
                  value={role}
                  disabled={
                    role === "org_admin" && row.role !== "org_admin" && !row.can_grant_org_admin
                  }
                >
                  {ROLE_LABELS[role]}
                </MenuItem>
              ))}
            </Select>
          ) : (
            <Chip
              label={ROLE_LABELS[row.role]}
              size="small"
              color={row.role === "org_admin" ? "primary" : "default"}
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
            <Tooltip
              title={row.user_id === selfId ? "Leave organization" : "Remove from organization"}
            >
              <span>
                <IconButton
                  size="small"
                  disabled={busy !== null}
                  onClick={() => act({ userId: row.user_id, remove: true })}
                  aria-label={
                    row.user_id === selfId
                      ? "Leave this organization"
                      : `Remove ${row.email} from the organization`
                  }
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ],
    [act, busy, selfId],
  );
  // Nothing to offer when nobody may be removed, as for the operator, who
  // restores an admin and nothing more.
  const shown = (members ?? []).some((m) => m.can_remove)
    ? columns
    : columns.filter((c) => c.field !== "actions");

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Users</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Organization admins administer every workspace in the organization. Someone is removed
        from each workspace before they can be removed from the organization.
      </Typography>
      <OrganizationUsersNotices
        asOperator={asOperator}
        lockedOut={lockedOut || (asOperator && errorStatus === 403)}
        error={error}
        loaded={!loading && !error}
        fromDirectory={fromDirectory}
        directoryTakesChanges={directoryTakesChanges}
      />
      {actionError && (
        <Alert
          severity="error"
          onClose={dismissError}
          action={
            toFinish && (
              <Button color="inherit" size="small" onClick={finish}>
                Confirm sign-in to finish
              </Button>
            )
          }
        >
          {actionError}
        </Alert>
      )}
      {actionWarning && (
        <Alert severity="warning" onClose={dismissWarning}>
          {actionWarning}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : error || lockedOut ? null : (
        <DataTable
          rows={(members ?? []).map((m) => ({ ...m, id: m.user_id }))}
          columns={shown}
          emptyState={<TableEmptyState title="No users in this organization yet" />}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
    </Stack>
  );
}

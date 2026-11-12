import { Alert, Box, Chip, Link, Stack, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import DataTable, { type TableColumn, TableEmptyState } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import ConfirmDialog from "../../components/ConfirmDialog";
import { type Member, type TenantRole, removeMember, updateMemberRole } from "../../data/api";
import ChangeRoleDialog from "./ChangeRoleDialog";
import { removalNotice } from "./memberRemoval";
import RemoveMemberDialog from "./RemoveMemberDialog";
import { type RoleTone, roleOf } from "./roles";

type MemberRow = Member & { id: string };

const ROLE_ORDER: readonly string[] = ["Org admin", "Workspace admin", "Member"];

/** Kept stable: a fresh array on each render rebuilds the grid's columns. */
const PINNED_ACTIONS = ["actions"];

const ORG_ADMIN_ROLE_REASON = "An org admin's role is changed in Organization settings.";
const ORG_ADMIN_REMOVE_REASON = "An org admin is removed in Organization settings.";

/** Org admin reads strongest, Workspace admin muted, Member quiet: three steps
 * on one axis, so the scan down the column is ordered. */
function RoleChip({ label, tone }: { label: string; tone: RoleTone }) {
  if (tone === "organization") return <Chip label={label} size="small" color="primary" />;
  if (tone === "admin") return <Chip label={label} size="small" />;
  return <Chip label={label} size="small" variant="outlined" />;
}

type Pending =
  | { kind: "change"; member: Member }
  | { kind: "step-down"; member: Member }
  | { kind: "remove"; member: Member };

interface Props {
  tenantId: string;
  workspaceName: string;
  members: Member[];
  /** The signed-in person's id. The platform operator looking into someone
   * else's workspace has no row here. */
  selfId: string;
  administers: boolean;
  /** Whether "via organization" may link to the organization's users. */
  canOpenOrganizationUsers: boolean;
  /** Read the roster again after a change. */
  onChanged: () => Promise<void>;
  /** After stepping down: what this person may do here has changed. */
  onSelfChanged: () => Promise<void>;
  /** After leaving: the session is on another workspace now, or none, and
   * the page follows it. */
  onLeft: () => Promise<void>;
}

/** The workspace's roster. What each row offers is the server's answer for
 * that member (`can_change_role`, `can_remove`, and why not), so the roles
 * offered are the ones it takes from this person. An organization admin's row
 * is read-only: their standing comes from the organization, whatever their
 * own membership says, and is changed in its settings. */
export default function UsersTable({
  tenantId,
  workspaceName,
  members,
  selfId,
  administers,
  canOpenOrganizationUsers,
  onChanged,
  onSelfChanged,
  onLeft,
}: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  // What the last removal handed over, and what it could not revoke, as the
  // server reported them. Kept across leaving, when the page moves on to the
  // workspace the session is on now.
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const columns = useMemo<TableColumn<MemberRow>[]>(() => {
    const present = new Set(members.map((m) => roleOf(m).label));
    const rowActions = (row: MemberRow): RowAction[] => {
      if (row.organization_role === "org_admin") {
        return [
          { label: "Change role", onClick: () => {}, disabledReason: ORG_ADMIN_ROLE_REASON },
          { label: "Remove from workspace", onClick: () => {}, disabledReason: ORG_ADMIN_REMOVE_REASON },
        ];
      }
      const self = row.user_id === selfId;
      const actions: RowAction[] = [];
      if (row.can_change_role || row.change_role_blocked_reason !== null) {
        actions.push({
          label: self ? "Step down to Member" : "Change role",
          onClick: () => setPending({ kind: self ? "step-down" : "change", member: row }),
          disabledReason: row.change_role_blocked_reason,
        });
      }
      if (row.can_remove || row.remove_blocked_reason !== null) {
        actions.push({
          label: self ? "Leave workspace" : "Remove from workspace",
          onClick: () => setPending({ kind: "remove", member: row }),
          destructive: true,
          disabledReason: row.remove_blocked_reason,
        });
      }
      return actions;
    };

    return [
      {
        field: "name",
        headerName: "User",
        flex: 1,
        minWidth: 260,
        renderCell: ({ row }) => (
          <Stack sx={{ justifyContent: "center", height: "100%", minWidth: 0, lineHeight: 1.3 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                {row.name}
                {row.user_id === selfId && (
                  <Box component="span" sx={{ fontWeight: 400, color: "text.secondary" }}>
                    {" "}
                    (you)
                  </Box>
                )}
              </Typography>
              {row.service_account && (
                <Chip label="Service account" size="small" variant="outlined" />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" noWrap>
              {row.email}
            </Typography>
          </Stack>
        ),
      },
      {
        field: "role",
        headerName: "Role",
        width: 280,
        valueGetter: (_value, row) => roleOf(row).label,
        sortComparator: (a, b) => ROLE_ORDER.indexOf(a as string) - ROLE_ORDER.indexOf(b as string),
        filter: {
          value: (row) => roleOf(row).label,
          options: ROLE_ORDER.filter((label) => present.has(label)).map((label) => ({
            value: label,
            label,
          })),
        },
        renderCell: ({ row, tabIndex }) => {
          const role = roleOf(row);
          return (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", height: "100%" }}>
              <RoleChip {...role} />
              {role.tone === "organization" &&
                (canOpenOrganizationUsers ? (
                  <Link
                    component={RouterLink}
                    to="/settings/org/users"
                    variant="caption"
                    tabIndex={tabIndex}
                  >
                    via organization
                  </Link>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    via organization
                  </Typography>
                ))}
            </Stack>
          );
        },
      },
      ...(administers
        ? [
            {
              field: "actions",
              headerName: "",
              width: 64,
              sortable: false,
              disableColumnMenu: true,
              renderCell: ({ row, tabIndex }) => (
                <RowActionsMenu
                  label={`Actions for ${row.name}`}
                  actions={rowActions(row)}
                  tabIndex={tabIndex}
                />
              ),
            } satisfies TableColumn<MemberRow>,
          ]
        : []),
    ];
  }, [members, selfId, administers, canOpenOrganizationUsers]);

  const changeRole = async (member: Member, role: TenantRole) => {
    await updateMemberRole(tenantId, member.user_id, role);
    await onChanged();
  };

  const stepDown = async (member: Member) => {
    await updateMemberRole(tenantId, member.user_id, "member");
    await onChanged();
    await onSelfChanged();
  };

  const remove = async (member: Member) => {
    const result = await removeMember(tenantId, member.user_id);
    setNotice(removalNotice(member, result, selfId));
    setWarning(result.warning);
    if (member.user_id === selfId) {
      await onLeft();
      return;
    }
    await onChanged();
  };

  const close = () => setPending(null);

  return (
    <Stack spacing={1.5}>
      {notice !== null && (
        <Alert severity="info" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {warning !== null && (
        <Alert severity="warning" onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      )}
      <DataTable
        rows={members.map((m) => ({ ...m, id: m.user_id }))}
        columns={columns}
        noun={{ one: "user", other: "users" }}
        search={{ label: "Search users", text: (row) => `${row.name} ${row.email}` }}
        pinnedRight={administers ? PINNED_ACTIONS : undefined}
        emptyState={<TableEmptyState title="No users in this workspace yet" />}
        height={640}
        pageSize={25}
      />
      {pending?.kind === "change" && (
        <ChangeRoleDialog
          member={pending.member}
          onSave={(role) => changeRole(pending.member, role)}
          onClose={close}
        />
      )}
      {pending?.kind === "step-down" && (
        <ConfirmDialog
          open
          title="Step down to Member?"
          description={`You'll stop being an admin of ${workspaceName}: no more managing its users, invite links, or other people's agents and rooms. Another admin can make you one again.`}
          confirmLabel="Step down"
          tone="plain"
          onConfirm={() => stepDown(pending.member)}
          onClose={close}
        />
      )}
      {pending?.kind === "remove" && (
        <RemoveMemberDialog
          tenantId={tenantId}
          member={pending.member}
          workspaceName={workspaceName}
          selfId={selfId}
          onRemove={() => remove(pending.member)}
          onClose={close}
        />
      )}
    </Stack>
  );
}

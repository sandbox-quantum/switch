import Add from "@mui/icons-material/Add";
import AdminPanelSettingsOutlined from "@mui/icons-material/AdminPanelSettingsOutlined";
import GroupAddOutlined from "@mui/icons-material/GroupAddOutlined";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import ManageAccountsOutlined from "@mui/icons-material/ManageAccountsOutlined";
import PersonOffOutlined from "@mui/icons-material/PersonOffOutlined";
import PersonRemoveOutlined from "@mui/icons-material/PersonRemoveOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import DataTable, { type TableColumn, TableEmptyState } from "../../../components/DataTable";
import InfoTip from "../../../components/InfoTip";
import PageHeader from "../../../components/PageHeader";
import RowActionsMenu, { type RowAction } from "../../../components/RowActionsMenu";
import SuccessSnackbar from "../../../components/SuccessSnackbar";
import { useAuth } from "../../../data/AuthContext";
import {
  type CurrentOrganization,
  type OrganizationMemberEntry,
  type OrganizationMemberWorkspace,
  type OrganizationWorkspace,
  fetchOrganizationMembers,
  fetchOrganizationWorkspaces,
} from "../../../data/api";
import CreateInvitationDialog from "../../workspace/CreateInvitationDialog";
import { workspaceRoleLabel } from "../../workspace/roles";
import { useLoad } from "../../workspace/useLoad";
import UserAvatar from "../../workspace/UserAvatar";
import { useMemberChanges } from "../memberChanges";
import OrganizationUsersNotices from "../OrganizationUsersNotices";
import InviteWorkspacePicker from "./InviteWorkspacePicker";
import RemoveFromWorkspaceDialog from "./RemoveFromWorkspaceDialog";
import WorkspaceRoleDialog from "./WorkspaceRoleDialog";

type Row = OrganizationMemberEntry & { id: string };

const ROLE_LABELS = { org_admin: "Org admin", member: "Member" } as const;
// Switch stores `member` either way. Where the members come from the
// organization's WorkOS account, the roles are shown as Switch Trust names
// them, so the two products use one word for each.
const DIRECTORY_ROLE_LABELS = { org_admin: "Org Admin", member: "Viewer" } as const;
type RoleLabels = typeof ROLE_LABELS | typeof DIRECTORY_ROLE_LABELS;

/** Kept stable: a fresh array on each render rebuilds the grid's columns. */
const PINNED_ACTIONS = ["actions"];

const USER_SEARCH = {
  label: "Search users",
  text: (row: OrganizationMemberEntry) =>
    `${row.name} ${row.email} ${row.workspaces.map((w) => w.name).join(" ")}`,
};

function roleFilter(labels: RoleLabels) {
  return {
    value: (row: OrganizationMemberEntry) => labels[row.role],
    options: [
      { value: labels.org_admin, label: labels.org_admin },
      { value: labels.member, label: labels.member },
    ],
  };
}

/** What a change also does in Switch Trust, which reads the same WorkOS
 * membership, said where the change is sent there. */
function trustNote(kind: "promote" | "demote" | "remove", self: boolean): string {
  const they = self ? "You" : "They";
  if (kind === "promote") return ` ${they} also become Org Admin in Switch Trust, with billing permissions.`;
  if (kind === "demote")
    return ` ${they} become Viewer in Switch Trust. ${self ? "Your" : "Their"} earlier Switch Trust role is not kept.`;
  return ` ${they} are also removed from the organization in Switch Trust, and ${self ? "your" : "their"} Switch Trust API keys are revoked.`;
}

const WORKSPACE_FILTER = {
  value: (row: OrganizationMemberEntry) =>
    row.workspaces.length > 0 ? row.workspaces.map((w) => w.name) : ["No workspace"],
};

const SERVICE_ACCOUNT_REASON =
  "Agents added with the shared registration token act with this account's role, so it can't be made an admin.";

const ORG_ADMIN_WORKSPACE_REASON =
  "An org admin administers every workspace already; their role in one is not changed here.";

type Pending =
  | { kind: "promote"; member: OrganizationMemberEntry }
  | { kind: "demote"; member: OrganizationMemberEntry }
  | { kind: "remove-organization"; member: OrganizationMemberEntry }
  | { kind: "add"; member: OrganizationMemberEntry }
  | { kind: "change"; member: OrganizationMemberEntry }
  | { kind: "remove-workspace"; member: OrganizationMemberEntry };

/** The workspaces someone is in, each with their role there; an org admin in
 * none is in the organization as a whole. */
function WorkspacesCell({ row }: { row: OrganizationMemberEntry }) {
  if (row.workspaces.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {row.role === "org_admin" ? "Organization-wide" : "No workspace"}
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", height: "100%", flexWrap: "wrap", py: 0.5 }}>
      {row.workspaces.map((workspace) => (
        <WorkspaceChip key={workspace.id} workspace={workspace} />
      ))}
    </Stack>
  );
}

function WorkspaceChip({ workspace }: { workspace: OrganizationMemberWorkspace }) {
  const role = workspace.role === "admin" ? " · Admin" : "";
  const label = `${workspace.name}${role}`;
  return (
    <Tooltip
      title={`${workspaceRoleLabel(workspace.role)} of ${workspace.name}${workspace.archived ? ", which is archived" : ""}`}
    >
      <Chip
        label={workspace.archived ? `${label} (archived)` : label}
        size="small"
        variant={workspace.archived ? "outlined" : "filled"}
        sx={workspace.archived ? { color: "text.secondary" } : undefined}
      />
    </Tooltip>
  );
}

/** Organization settings › Users: everyone in the
 * organization, the workspaces of it they are in and their role in each.
 * Its admins make someone Org admin or take it back, add them to another
 * workspace, change their role in one or remove them from it, remove them
 * from the organization once they are in none, and make invite links to any
 * of its workspaces. What each row offers follows the server's answer for
 * that person; where it refuses, it says why and that is shown. */
export default function OrganizationUsersSettings({
  organization,
  onChanged,
}: {
  organization: CurrentOrganization;
  // After a change to the organization's members: the issues and the
  // organization's own answers are read again.
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const selfId = session?.user.id ?? "";
  const asOperator = !organization.administers;
  const lockedOut = asOperator && !organization.can_manage_members;
  const labels: RoleLabels = organization.members_from_directory ? DIRECTORY_ROLE_LABELS : ROLE_LABELS;
  const toTrust =
    organization.members_from_directory && organization.directory_takes_changes && !asOperator;
  const loadMembers = useCallback(
    () => (lockedOut ? Promise.resolve(null) : fetchOrganizationMembers()),
    [lockedOut],
  );
  const members = useLoad(loadMembers);
  const loadWorkspaces = useCallback(
    () => (organization.administers ? fetchOrganizationWorkspaces() : Promise.resolve([])),
    [organization.administers],
  );
  const workspaces = useLoad(loadWorkspaces);
  const changes = useMemberChanges({
    organizationId: organization.id,
    selfId,
    asOperator,
    onChanged,
    reload: members.refetch,
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [inviting, setInviting] = useState<"pick" | OrganizationWorkspace | null>(null);
  // What a removal from a workspace did, and what it couldn't revoke, stay on
  // the page; a plain change is said in the snackbar.
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const workspaceChanged = useCallback(async () => {
    onChanged();
    await members.refetch();
  }, [members, onChanged]);

  const removedFromWorkspace = useCallback(
    async (message: string, removalWarning: string | null) => {
      setNotice(message);
      setWarning(removalWarning);
      await workspaceChanged();
    },
    [workspaceChanged],
  );

  // The workspaces someone could be added to, or why none can be offered yet.
  const openWorkspaceIds = useMemo(
    () =>
      workspaces.data === null
        ? null
        : workspaces.data.filter((w) => w.archived_at === null).map((w) => w.id),
    [workspaces.data],
  );
  const workspacesError = workspaces.error;
  const noOpenWorkspace =
    openWorkspaceIds === null
      ? workspacesError !== null
        ? "The organization's workspaces couldn't be loaded."
        : "Loading the organization's workspaces…"
      : openWorkspaceIds.length === 0
        ? "Every workspace in the organization is archived."
        : null;

  const columns = useMemo<TableColumn<Row>[]>(() => {
    const administers = organization.administers;
    const rowActions = (row: Row): RowAction[] => {
      const self = row.user_id === selfId;
      const actions: RowAction[] = [];
      if (row.can_change_role || row.change_role_blocked_reason !== null) {
        if (row.role === "org_admin") {
          actions.push({
            label: self ? `Step down to ${labels.member}` : `Make ${labels.member}`,
            icon: <ManageAccountsOutlined fontSize="small" />,
            onClick: () => setPending({ kind: "demote", member: row }),
            disabledReason: row.change_role_blocked_reason,
          });
        } else {
          actions.push({
            label: `Make ${labels.org_admin}`,
            icon: <AdminPanelSettingsOutlined fontSize="small" />,
            onClick: () => setPending({ kind: "promote", member: row }),
            disabledReason: row.can_grant_org_admin
              ? null
              : row.service_account
                ? SERVICE_ACCOUNT_REASON
                : "Org admin is granted in your organization's account settings.",
          });
        }
      }
      if (administers) {
        const orgAdmin = row.role === "org_admin";
        // The organization's only org admin can't step down, so "Make them a
        // Member first" would send them round in a circle.
        const orgAdminStays =
          row.change_role_blocked_reason !== null
            ? `An org admin stays in every workspace while they are one. ${row.change_role_blocked_reason}`
            : `An org admin stays in every workspace while they are one. Make them a ${labels.member} first.`;
        actions.push(
          {
            label: "Add to a workspace",
            icon: <GroupAddOutlined fontSize="small" />,
            onClick: () => setPending({ kind: "add", member: row }),
            disabledReason:
              noOpenWorkspace ??
              (openWorkspaceIds!.every((id) => row.workspaces.some((w) => w.id === id))
                ? "They're already in every workspace that isn't archived."
                : null),
          },
          {
            label: "Change role in a workspace",
            icon: <ManageAccountsOutlined fontSize="small" />,
            onClick: () => setPending({ kind: "change", member: row }),
            disabledReason: orgAdmin
              ? ORG_ADMIN_WORKSPACE_REASON
              : row.workspaces.length === 0
                ? "They're in no workspace."
                : null,
          },
          {
            label: self ? "Leave a workspace" : "Remove from a workspace",
            icon: self ? <LogoutOutlined fontSize="small" /> : <PersonRemoveOutlined fontSize="small" />,
            onClick: () => setPending({ kind: "remove-workspace", member: row }),
            destructive: true,
            disabledReason: orgAdmin
              ? orgAdminStays
              : row.workspaces.length === 0
                ? "They're in no workspace."
                : null,
          },
        );
      }
      if (row.can_remove || row.remove_blocked_reason !== null) {
        const names = row.workspaces.map((w) => w.name).join(", ");
        actions.push({
          label: self ? "Leave organization" : "Remove from organization",
          icon: self ? <LogoutOutlined fontSize="small" /> : <PersonOffOutlined fontSize="small" />,
          onClick: () => setPending({ kind: "remove-organization", member: row }),
          destructive: true,
          disabledReason:
            row.remove_blocked_reason ??
            (row.workspaces.length > 0
              ? `Remove ${self ? "yourself" : "them"} from the organization's workspaces first: ${names}.`
              : null),
        });
      }
      return actions;
    };

    return [
      {
        field: "name",
        headerName: "User",
        flex: 1,
        minWidth: 240,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", height: "100%", minWidth: 0 }}>
            <UserAvatar name={row.name} email={row.email} />
            <Stack sx={{ minWidth: 0, lineHeight: 1.3 }}>
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
                {row.service_account && <Chip label="Service account" size="small" variant="outlined" />}
              </Stack>
              <Typography variant="caption" color="text.secondary" noWrap>
                {row.email}
              </Typography>
            </Stack>
          </Stack>
        ),
      },
      {
        field: "role",
        headerName: "Organization role",
        width: 170,
        valueGetter: (_value, row) => labels[row.role],
        filter: roleFilter(labels),
        renderCell: ({ row }) =>
          row.role === "org_admin" ? (
            <Chip label={labels.org_admin} size="small" color="primary" />
          ) : (
            <Chip label={labels.member} size="small" variant="outlined" />
          ),
      },
      {
        field: "workspaces",
        headerName: "Workspaces",
        flex: 1.4,
        minWidth: 260,
        sortable: false,
        filter: WORKSPACE_FILTER,
        renderCell: ({ row }) => <WorkspacesCell row={row} />,
      },
      {
        field: "actions",
        headerName: "",
        width: 64,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => {
          const actions = rowActions(row);
          return actions.length > 0 ? (
            <RowActionsMenu label={`Actions for ${row.name}`} actions={actions} tabIndex={tabIndex} />
          ) : null;
        },
      },
    ];
  }, [organization.administers, selfId, openWorkspaceIds, noOpenWorkspace, labels]);

  const close = () => setPending(null);
  const openWorkspaces = (workspaces.data ?? []).filter((w) => w.archived_at === null);

  return (
    <Box>
      <PageHeader
        sx={{ mb: 3 }}
        title={<Typography variant="h5">Users</Typography>}
        description={
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              Everyone in {organization.name}. Someone is removed from each workspace before they can
              be removed from the organization.
            </Typography>
            <InfoTip>
              Workspaces lists the ones each person is a member of. Org admins also administer every
              workspace through the organization, so each workspace's user count includes them.
            </InfoTip>
          </Stack>
        }
        actions={
          organization.administers && (
            <Tooltip title={noOpenWorkspace ?? ""}>
              {/* A disabled button fires no events, so the tooltip listens on this. */}
              <Box component="span">
                <Button
                  variant="contained"
                  startIcon={<Add />}
                  onClick={() => setInviting("pick")}
                  disabled={noOpenWorkspace !== null}
                >
                  Invite users
                </Button>
              </Box>
            </Tooltip>
          )
        }
      />
      <Stack spacing={1.5} sx={{ mb: 3 }}>
        <OrganizationUsersNotices
          asOperator={asOperator}
          lockedOut={lockedOut || (asOperator && members.errorStatus === 403)}
          error={members.error}
          loaded={!members.loading && members.error === null}
          fromDirectory={organization.members_from_directory}
          directoryTakesChanges={organization.directory_takes_changes}
        />
        {workspaces.error !== null && (
          <Alert severity="warning">
            Couldn't load the organization's workspaces, so people can't be added to one or
            invited: {workspaces.error}
          </Alert>
        )}
        {changes.actionError && (
          <Alert
            severity="error"
            onClose={changes.dismissError}
            action={
              changes.toFinish && (
                <Button color="inherit" size="small" onClick={changes.finish}>
                  Confirm sign-in to finish
                </Button>
              )
            }
          >
            {changes.actionError}
          </Alert>
        )}
        {changes.actionWarning && (
          <Alert severity="warning" onClose={changes.dismissWarning}>
            {changes.actionWarning}
          </Alert>
        )}
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
      </Stack>
      {members.loading ? (
        <CircularProgress />
      ) : members.data === null || members.error !== null ? null : (
        <DataTable
          rows={members.data.map((m) => ({ ...m, id: m.user_id }))}
          columns={columns}
          noun={{ one: "user", other: "users" }}
          search={USER_SEARCH}
          pinnedRight={PINNED_ACTIONS}
          emptyState={<TableEmptyState title="No users in this organization yet" />}
          height={640}
          pageSize={25}
        />
      )}
      {pending?.kind === "promote" && (
        <ConfirmDialog
          open
          title={`Make ${labels.org_admin}`}
          description={
            `${pending.member.name} will administer all of ${organization.name}: every workspace, every user and the organization's settings.` +
            (toTrust ? trustNote("promote", pending.member.user_id === selfId) : "")
          }
          confirmLabel={`Make ${labels.org_admin}`}
          tone="plain"
          onConfirm={() => changes.act({ userId: pending.member.user_id, role: "org_admin" })}
          onClose={close}
        />
      )}
      {pending?.kind === "demote" && (
        <ConfirmDialog
          open
          title={
            pending.member.user_id === selfId ? `Step down to ${labels.member}?` : `Make ${labels.member}`
          }
          description={
            (pending.member.user_id === selfId
              ? `You'll stop administering ${organization.name} and its workspaces, keeping only your own role in each. What you held in workspaces you were in only as an org admin is taken away.`
              : `${pending.member.name} stops administering ${organization.name} and its workspaces, keeping only their own role in each. What they held in workspaces they were in only as an org admin is taken away.`) +
            (toTrust ? trustNote("demote", pending.member.user_id === selfId) : "")
          }
          confirmLabel={pending.member.user_id === selfId ? "Step down" : `Make ${labels.member}`}
          tone="plain"
          onConfirm={() => changes.act({ userId: pending.member.user_id, role: "member" })}
          onClose={close}
        />
      )}
      {pending?.kind === "remove-organization" && (
        <ConfirmDialog
          open
          title={
            pending.member.user_id === selfId ? `Leave ${organization.name}?` : "Remove from organization"
          }
          description={
            (pending.member.user_id === selfId
              ? `You'll no longer be part of ${organization.name}.`
              : `${pending.member.name} is no longer part of ${organization.name}.`) +
            (toTrust ? trustNote("remove", pending.member.user_id === selfId) : "")
          }
          confirmLabel={pending.member.user_id === selfId ? "Leave" : "Remove"}
          tone="destructive"
          onConfirm={() => changes.act({ userId: pending.member.user_id, remove: true })}
          onClose={close}
        />
      )}
      {(pending?.kind === "add" || pending?.kind === "change") && (
        <WorkspaceRoleDialog
          mode={pending.kind}
          member={pending.member}
          workspaces={
            pending.kind === "add"
              ? openWorkspaces.filter((w) => !pending.member.workspaces.some((held) => held.id === w.id))
              : pending.member.workspaces
          }
          onDone={async (message) => {
            setDone(message);
            await workspaceChanged();
          }}
          onClose={close}
        />
      )}
      {pending?.kind === "remove-workspace" && (
        <RemoveFromWorkspaceDialog
          member={pending.member}
          selfId={selfId}
          onRemoved={removedFromWorkspace}
          onClose={close}
        />
      )}
      {inviting === "pick" && (
        <InviteWorkspacePicker
          workspaces={openWorkspaces}
          currentId={session?.tenant?.id ?? null}
          onPick={(workspace) => setInviting(workspace)}
          onClose={() => setInviting(null)}
        />
      )}
      {inviting !== null && inviting !== "pick" && (
        <CreateInvitationDialog
          open
          tenantId={inviting.id}
          fromOrganization
          workspaceName={inviting.name}
          emailEnabled={session?.invite_email_enabled ?? false}
          onClose={() => setInviting(null)}
        />
      )}
      <SuccessSnackbar message={done} onClose={() => setDone(null)} />
    </Box>
  );
}

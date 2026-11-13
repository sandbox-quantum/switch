import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PeopleOutlined from "@mui/icons-material/PeopleOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import { Alert, Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import DataTable, { type TableColumn, TableEmptyState } from "../../../components/DataTable";
import ConfirmDialog from "../../../components/ConfirmDialog";
import RowActionsMenu, { type RowAction } from "../../../components/RowActionsMenu";
import { useAuth } from "../../../data/AuthContext";
import {
  type OrganizationWorkspace,
  archiveOrganizationWorkspace,
  renameOrganizationWorkspace,
  restoreOrganizationWorkspace,
  setOrganizationWorkspaceAdmins,
} from "../../../data/api";
import { EM_DASH, TABULAR_SX, formatDate } from "../../../theme/format";
import { adminsNotice, archiveWorkspaceBody } from "./copy";
import ManageAdminsDialog from "./ManageAdminsDialog";
import RenameWorkspaceDialog from "./RenameWorkspaceDialog";

/** Kept stable: a fresh array on each render rebuilds the grid's columns. */
const PINNED_ACTIONS = ["actions"];

export const WORKSPACE_SEARCH = {
  label: "Search workspaces",
  text: (row: OrganizationWorkspace) => `${row.name} ${row.admins.join(" ")}`,
};

function Stat({
  icon,
  count,
  singular,
  plural,
}: {
  icon: ReactNode;
  count: number;
  singular: string;
  plural: string;
}) {
  const label = `${count} ${count === 1 ? singular : plural}`;
  return (
    <Tooltip title={label}>
      {/* One accessible node ("12 users"), its children hidden from it, so a
       *  screen reader isn't read the bare icon and the bare number apart. */}
      <Stack direction="row" spacing={0.5} role="img" aria-label={label} sx={{ alignItems: "center" }}>
        <Box component="span" aria-hidden sx={{ display: "flex", color: "text.secondary" }}>
          {icon}
        </Box>
        <Typography variant="body2" aria-hidden sx={TABULAR_SX}>
          {count}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function StatsCell({ row }: { row: OrganizationWorkspace }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", height: "100%" }}>
      <Stat icon={<PeopleOutlined fontSize="small" />} count={row.users} singular="user" plural="users" />
      <Stat icon={<SmartToyOutlined fontSize="small" />} count={row.agents} singular="agent" plural="agents" />
      <Stat
        icon={<MeetingRoomOutlined fontSize="small" />}
        count={row.rooms}
        singular="room"
        plural="rooms"
      />
    </Stack>
  );
}

/** A cell's content on one line, centred in the row's height as the grid's
 * own text cells are. */
function CellLine({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", height: "100%", minWidth: 0 }}>
      {children}
    </Stack>
  );
}

const NO_ADMINS_REASON =
  "No one in this workspace has the workspace admin role yet. Org admins can still administer it.";

function AdminsCell({ admins }: { admins: readonly string[] }) {
  if (admins.length === 0) {
    return (
      <Tooltip title={NO_ADMINS_REASON}>
        <Typography variant="body2" color="text.secondary" aria-label={NO_ADMINS_REASON}>
          {EM_DASH}
        </Typography>
      </Tooltip>
    );
  }
  const shown = admins.slice(0, 2).join(", ");
  const rest = admins.length - 2;
  if (rest <= 0) {
    return <Typography variant="body2">{shown}</Typography>;
  }
  const all = admins.join(", ");
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
      <Typography variant="body2">{shown}</Typography>
      <Tooltip title={all}>
        <Typography variant="body2" color="text.secondary" aria-label={all}>
          +{rest}
        </Typography>
      </Tooltip>
    </Stack>
  );
}

type Pending =
  | { kind: "rename"; workspace: OrganizationWorkspace }
  | { kind: "admins"; workspace: OrganizationWorkspace }
  | { kind: "archive"; workspace: OrganizationWorkspace };

interface Props {
  /** Whether this viewer may change workspaces: an organization admin, never
   * a plain member (who has no reason to be on this page) or, while the
   * organization has an admin, the platform operator. Without it the row
   * offers nothing: no "…" at all, rather than one that opens on reasons. */
  administers: boolean;
  /** The workspace the session is on now, so its row can say so; null for a
   * session with none (the platform operator, say). */
  currentId: string | null;
  workspaces: OrganizationWorkspace[];
  /** Read the organization's workspaces again after a change. */
  onChanged: () => Promise<void>;
  /** A change went through: shown as the page's one notice. */
  onNotice: (message: string) => void;
}

/** The organization's workspaces, and for its admins, what can be done with
 * each: switch into it, rename it, pick its admins, archive it or bring it
 * back. Every action follows the server's answer for that workspace. */
export default function WorkspacesTable({
  administers,
  currentId,
  workspaces,
  onChanged,
  onNotice,
}: Props) {
  const { switchTo, recheck } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const close = () => setPending(null);

  const switchWorkspace = async (workspaceId: string) => {
    try {
      await switchTo(workspaceId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const restore = async (workspace: OrganizationWorkspace) => {
    try {
      const result = await restoreOrganizationWorkspace(workspace.id);
      onNotice(`Restored ${result.name}.`);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const archive = async (workspace: OrganizationWorkspace) => {
    const result = await archiveOrganizationWorkspace(workspace.id);
    onNotice(`Archived ${result.name}.`);
    await onChanged();
  };

  const rename = async (workspace: OrganizationWorkspace, name: string) => {
    const result = await renameOrganizationWorkspace(workspace.id, name);
    onNotice(`Renamed to ${result.name}.`);
    if (workspace.id === currentId) await recheck();
    await onChanged();
  };

  const saveAdmins = async (workspace: OrganizationWorkspace, userIds: string[]) => {
    const result = await setOrganizationWorkspaceAdmins(workspace.id, userIds);
    onNotice(adminsNotice(result.name, result.admins.length));
    await onChanged();
  };

  const columns = useMemo<TableColumn<OrganizationWorkspace>[]>(() => {
    const rowActions = (row: OrganizationWorkspace): RowAction[] => {
      const actions: RowAction[] = [];
      if (row.id !== currentId) {
        actions.push({ label: "Switch to workspace", onClick: () => void switchWorkspace(row.id) });
      }
      actions.push({ label: "Rename workspace", onClick: () => setPending({ kind: "rename", workspace: row }) });
      actions.push({ label: "Manage admins", onClick: () => setPending({ kind: "admins", workspace: row }) });
      if (row.archived_at === null) {
        actions.push({
          label: "Archive workspace",
          onClick: () => setPending({ kind: "archive", workspace: row }),
          destructive: true,
          disabledReason: row.can_archive ? null : row.archive_blocked_reason,
        });
      } else if (row.can_restore) {
        actions.push({ label: "Restore workspace", onClick: () => void restore(row) });
      }
      return actions;
    };

    const base: TableColumn<OrganizationWorkspace>[] = [
      {
        field: "name",
        headerName: "Workspace",
        flex: 1,
        minWidth: 220,
        renderCell: ({ row }) => (
          <CellLine>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.name}
              {row.id === currentId && (
                <Box component="span" sx={{ fontWeight: 400, color: "text.secondary" }}>
                  {" "}
                  (current)
                </Box>
              )}
            </Typography>
          </CellLine>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        valueGetter: (_value, row) => (row.archived_at ? "Archived" : "Active"),
        filter: { value: (row) => (row.archived_at ? "Archived" : "Active") },
        renderCell: ({ row }) => {
          const archived = row.archived_at !== null;
          return (
            <Chip
              label={archived ? "Archived" : "Active"}
              size="small"
              color={archived ? "default" : "success"}
              variant={archived ? "outlined" : "filled"}
              sx={archived ? { color: "text.secondary" } : undefined}
            />
          );
        },
      },
      {
        field: "stats",
        headerName: "Stats",
        width: 220,
        // Sorts by users: the first and, for most workspaces, largest of the
        // three counts shown.
        valueGetter: (_value, row) => row.users,
        renderCell: ({ row }) => <StatsCell row={row} />,
      },
      {
        field: "admins",
        headerName: "Admins",
        flex: 1,
        minWidth: 200,
        valueGetter: (_value, row) => row.admins.join(", "),
        renderCell: ({ row }) => (
          <CellLine>
            <AdminsCell admins={row.admins} />
          </CellLine>
        ),
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 120,
        valueFormatter: (value) => formatDate(value as string),
      },
    ];
    if (!administers) return base;
    return [
      ...base,
      {
        field: "actions",
        headerName: "",
        width: 64,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu label={`Actions for ${row.name}`} actions={rowActions(row)} tabIndex={tabIndex} />
        ),
      },
    ];
  }, [administers, currentId]);

  return (
    <>
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)} sx={{ mb: 2 }}>
          {actionError}
        </Alert>
      )}
      <DataTable
        rows={workspaces}
        columns={columns}
        noun={{ one: "workspace", other: "workspaces" }}
        search={WORKSPACE_SEARCH}
        initialSort={{ field: "stats", sort: "desc" }}
        pinnedRight={administers ? PINNED_ACTIONS : undefined}
        emptyState={<TableEmptyState title="No workspaces in this organization yet" />}
        height={640}
        pageSize={25}
      />
      {pending?.kind === "rename" && (
        <RenameWorkspaceDialog
          workspace={pending.workspace}
          onSave={(name) => rename(pending.workspace, name)}
          onClose={close}
        />
      )}
      {pending?.kind === "admins" && (
        <ManageAdminsDialog
          workspace={pending.workspace}
          onSave={(userIds) => saveAdmins(pending.workspace, userIds)}
          onClose={close}
        />
      )}
      {pending?.kind === "archive" && (
        <ConfirmDialog
          open
          title="Archive workspace"
          description={archiveWorkspaceBody(pending.workspace.name, pending.workspace.users)}
          confirmLabel="Archive"
          tone="destructive"
          onConfirm={() => archive(pending.workspace)}
          onClose={close}
        />
      )}
    </>
  );
}

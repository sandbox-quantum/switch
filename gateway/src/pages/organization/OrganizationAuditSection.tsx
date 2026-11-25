import { Alert, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useState } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import {
  ORGANIZATION_AUDIT_PAGE,
  type OrganizationAuditEvent,
  fetchOrganizationAuditEvents,
} from "../../data/api";
import { formatDate } from "../../theme/format";

const ACTION_LABELS: Record<string, string> = {
  "organization.created": "Organization created",
  "organization.renamed": "Organization renamed",
  "organization.workspace_created": "Workspace added",
  "organization.workspace_renamed": "Workspace renamed",
  "organization.workspace_archived": "Workspace archived",
  "organization.workspace_restored": "Workspace restored",
  "organization.member_added_to_workspace": "Added to a workspace",
  "organization.member_workspace_role_changed": "Role in a workspace changed",
  "organization.member_removed_from_workspace": "Removed from a workspace",
  "organization.member_joined_by_invitation": "Joined by invitation",
  "organization.member_joined_by_domain": "Joined by e-mail domain",
  "organization.role_changed": "Organization role changed",
  "organization.member_removed": "User removed",
  "organization.guardrails_connected": "Guardrails connected",
  "organization.guardrails_disconnected": "Guardrails disconnected",
  "organization.connector_app_saved": "Connector app saved",
  "organization.connector_app_removed": "Connector app removed",
  "organization.service_set": "Service switched",
  "organization.service_cleared": "Service left to workspaces",
  "organization.member_added_from_directory": "User added from WorkOS",
  "organization.member_promoted_from_directory": "Promoted to Org Admin from WorkOS",
  "organization.member_demoted_from_directory": "Demoted to Viewer from WorkOS",
  "organization.member_removed_from_directory": "User removed from WorkOS",
  "organization.directory_conflict": "WorkOS change broke a Switch rule",
  "organization.linked_to_directory": "Linked to WorkOS",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Workspace admin",
  member: "Member",
  org_admin: "Org admin",
};

// An organization role where the members come from the organization's WorkOS
// account, named as Switch Trust names it.
const DIRECTORY_ROLE_LABELS: Record<string, string> = {
  member: "Viewer",
  org_admin: "Org Admin",
};

function roleLabel(role: unknown, labels: Record<string, string>): string {
  return typeof role === "string" ? (labels[role] ?? ROLE_LABELS[role] ?? role) : "";
}

/** The workspace a change was in, and the role it gave or changed, from the
 * event's details: "Core · Member → Workspace admin". Empty for an event
 * that names neither. A change to the organization role, in an organization
 * whose members come from WorkOS, names the roles as Switch Trust does. */
export function auditDetail(event: OrganizationAuditEvent, membersFromDirectory: boolean): string {
  const details = event.details ?? {};
  const parts: string[] = [];
  const inWorkspace = typeof details.workspace_name === "string";
  const labels = membersFromDirectory && !inWorkspace ? DIRECTORY_ROLE_LABELS : ROLE_LABELS;
  if (inWorkspace) parts.push(details.workspace_name as string);
  if (details.from !== undefined && details.to !== undefined) {
    parts.push(`${roleLabel(details.from, labels)} → ${roleLabel(details.to, labels)}`);
  } else if (typeof details.role === "string") {
    parts.push(roleLabel(details.role, labels));
  }
  if (typeof details.domain === "string") parts.push(`via ${details.domain}`);
  return parts.join(" · ");
}

function columns(membersFromDirectory: boolean): GridColDef<OrganizationAuditEvent>[] {
  return [
  {
    field: "occurred_at",
    headerName: "When",
    width: 160,
    valueFormatter: (value) => formatDate(value as string),
  },
  {
    field: "action",
    headerName: "What",
    flex: 1,
    minWidth: 180,
    valueFormatter: (value) => ACTION_LABELS[String(value)] ?? String(value),
  },
  {
    field: "actor_name",
    headerName: "Who",
    flex: 1,
    minWidth: 160,
    valueGetter: (value, row) => {
      const who = value ?? row.actor_user_id ?? "Switch";
      return row.details?.platform_access ? `${who} (platform operator)` : who;
    },
  },
  {
    field: "target_name",
    headerName: "Of",
    flex: 1,
    minWidth: 160,
    valueGetter: (value, row) => {
      if (value) return value;
      const name = row.details?.name;
      return typeof name === "string" ? name : row.target_id;
    },
  },
  {
    field: "details",
    headerName: "Details",
    flex: 1.2,
    minWidth: 180,
    sortable: false,
    valueGetter: (_value, row) => auditDetail(row, membersFromDirectory),
  },
  ];
}

/** Kept stable: a fresh array on each render rebuilds the grid's columns. */
const COLUMNS = columns(false);
const DIRECTORY_COLUMNS = columns(true);

/** What changed in the organization as a whole, newest first, a page at a
 * time. A change the platform operator made through operator access alone is
 * marked. */
export default function OrganizationAuditSection({
  organizationName,
  membersFromDirectory,
}: {
  organizationName: string;
  membersFromDirectory: boolean;
}) {
  const [events, setEvents] = useState<OrganizationAuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether the last page came back full, so there may be older events.
  const [more, setMore] = useState(false);

  const loadPage = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const page = await fetchOrganizationAuditEvents(before);
      setEvents((shown) => (before === null ? page : [...shown, ...page]));
      setMore(page.length === ORGANIZATION_AUDIT_PAGE);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        <Typography variant="h5">Audit log</Typography>
        <Typography variant="body2" color="text.secondary">
          Changes to {organizationName}&apos;s workspaces, users and connectors, platform operator access included.
        </Typography>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {loading && events.length === 0 ? (
        <CircularProgress />
      ) : error !== null && events.length === 0 ? null : (
        <DataTable
          rows={events}
          columns={membersFromDirectory ? DIRECTORY_COLUMNS : COLUMNS}
          emptyState={
            <TableEmptyState title="Nothing recorded yet">
              Changes to this organization's workspaces and users are recorded here.
            </TableEmptyState>
          }
          height={Math.min(520, 108 + events.length * 52)}
          pageSize={25}
        />
      )}
      {more && (
        <Button
          sx={{ alignSelf: "flex-start" }}
          disabled={loading}
          onClick={() => loadPage(events[events.length - 1].occurred_at)}
        >
          Load older events
        </Button>
      )}
    </Stack>
  );
}

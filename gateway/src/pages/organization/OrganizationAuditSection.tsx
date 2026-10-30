import { Alert, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useState } from "react";
import DataTable from "../../components/DataTable";
import {
  ORGANIZATION_AUDIT_PAGE,
  type OrganizationAuditEvent,
  fetchOrganizationAuditEvents,
} from "../../data/api";
import { formatDate } from "../../theme/hootFormat";

const ACTION_LABELS: Record<string, string> = {
  "organization.created": "Organization created",
  "organization.workspace_created": "Workspace added",
  "organization.role_changed": "Organization role changed",
  "organization.member_removed": "Member removed",
  "organization.connector_app_saved": "Connector app saved",
  "organization.connector_app_removed": "Connector app removed",
};

const COLUMNS: GridColDef<OrganizationAuditEvent>[] = [
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
];

/** What changed in the organization as a whole, newest first, a page at a
 * time. A change the platform operator made through operator access alone is
 * marked. */
export default function OrganizationAuditSection() {
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
      <Typography variant="h6">Audit log</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {loading && events.length === 0 ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={events}
          columns={COLUMNS}
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

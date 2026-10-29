import { Alert, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo } from "react";
import DataTable from "../../components/DataTable";
import {
  type AuditEvent,
  fetchOrganizationAuditEvents,
  fetchOrganizationMembers,
} from "../../data/api";
import { formatDate } from "../../theme/hootFormat";
import { useLoad } from "../workspace/useLoad";

const ACTION_LABELS: Record<string, string> = {
  "organization.created": "Organization created",
  "organization.workspace_created": "Workspace added",
  "organization.role_changed": "Organization role changed",
  "organization.member_removed": "Member removed",
};

/** What changed in the organization as a whole, newest first. A change the
 * platform operator made through operator access alone is marked. */
export default function OrganizationAuditSection() {
  const load = useCallback(
    () => Promise.all([fetchOrganizationAuditEvents(), fetchOrganizationMembers()]),
    [],
  );
  const { data, error, loading } = useLoad(load);
  const [events, members] = data ?? [[], []];
  const names = useMemo(() => new Map(members.map((m) => [m.user_id, m.name])), [members]);

  const columns = useMemo<GridColDef<AuditEvent>[]>(
    () => [
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
        field: "actor_user_id",
        headerName: "Who",
        flex: 1,
        minWidth: 160,
        valueGetter: (value, row) => {
          const who = value ? (names.get(String(value)) ?? String(value)) : "Switch";
          return row.details?.platform_access ? `${who} (platform operator)` : who;
        },
      },
      {
        field: "target_id",
        headerName: "Of",
        flex: 1,
        minWidth: 160,
        valueGetter: (value, row) => {
          if (row.target_type === "user" && value) return names.get(String(value)) ?? value;
          const name = row.details?.name;
          return typeof name === "string" ? name : value;
        },
      },
    ],
    [names],
  );

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Audit log</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={events}
          columns={columns}
          height={Math.min(520, 108 + events.length * 52)}
          pageSize={25}
        />
      )}
    </Stack>
  );
}

import { Chip, Stack, Tooltip, Typography } from "@mui/material";
import { type ReactNode, useMemo } from "react";
import DataTable, { type FilterOption, type SelectFilter, type TableColumn } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import type { WorkspaceManagedAgent } from "../../data/management";
import { EM_DASH } from "../../theme/format";

/** A managed agent as the table shows it; `workspace_name` is for a table
 *  across several workspaces. */
export interface ManagedAgentTableRow extends WorkspaceManagedAgent {
  id: string;
  workspace_name?: string;
}

/** Each managed agent as a table row, keyed by its agent. */
export function managedAgentRows(agents: readonly WorkspaceManagedAgent[]): ManagedAgentTableRow[] {
  return agents.map((agent) => ({ ...agent, id: agent.agent_id }));
}

const PROCESS_COLOR: Record<string, "success" | "warning" | "error" | "default"> = {
  running: "success",
  starting: "warning",
  pending: "warning",
  restarting: "warning",
  stopping: "default",
  stopped: "default",
  crashed: "error",
  failed: "error",
};

/** What its device last reported of the agent, or why there is nothing to
 *  report. Null for one placed nowhere. */
export function actualState(row: WorkspaceManagedAgent): { label: string; color: "success" | "warning" | "error" | "default"; detail: string } | null {
  if (row.controller_id === null) return null;
  if (row.controller_state === "revoked")
    return {
      label: "device removed",
      color: "default",
      detail: "Its device was removed, so nothing runs this agent. Put it on another device to run it again.",
    };
  if (row.controller_state === "offline")
    return {
      label: "device offline",
      color: "warning",
      detail: "Its device isn't connected to Switch, so this agent isn't reachable. It runs again once the device is back.",
    };
  if (row.controller_state === "unknown")
    return {
      label: "unknown",
      color: "default",
      detail: "Its device has never connected to Switch, so this agent's state isn't known.",
    };
  if (row.process === null)
    return { label: "not reported yet", color: "default", detail: "Its device hasn't reported this agent yet." };
  return { label: row.process, color: PROCESS_COLOR[row.process] ?? "default", detail: "What its device last reported." };
}

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);
const NOT_PLACED = "\u0000not-placed";

/** Kept stable: a fresh array each render would rebuild the grid's columns. */
const PINNED = ["actions"];
const TABLE_CHROME = 108;
const ROW = 56;
const PAGE_SIZE = 10;

/**
 * Managed agents, each with its owner when `showOwner`, and its workspace
 * when `showWorkspace`. "Wanted" is what its owner asked for, "Actual" what
 * its device last reported, drawn differently so a row where they disagree
 * stands out.
 */
export default function ManagedAgentsTable({
  rows,
  showOwner,
  showWorkspace = false,
  providerLabel,
  actionsFor,
  emptyState,
}: {
  rows: ManagedAgentTableRow[];
  showOwner: boolean;
  showWorkspace?: boolean;
  providerLabel: (provider: string) => string;
  actionsFor: (row: ManagedAgentTableRow) => RowAction[];
  emptyState: ReactNode;
}) {
  const columns = useMemo<TableColumn<ManagedAgentTableRow>[]>(() => {
    const owners: FilterOption[] = [...new Map(rows.map((row) => [row.owner_id, row.owner_name])).entries()]
      .map(([value, label]) => ({ value, label }))
      .sort(byLabel);
    const workspaces: FilterOption[] = [...new Set(rows.flatMap((row) => (row.workspace_name ? [row.workspace_name] : [])))]
      .map((name) => ({ value: name, label: name }))
      .sort(byLabel);
    const devices: FilterOption[] = [
      ...[...new Map(rows.flatMap((row) => (row.controller_id ? [[row.controller_id, row.controller_name ?? row.controller_id]] : []))).entries()]
        .map(([value, label]) => ({ value, label }))
        .sort(byLabel),
      ...(rows.some((row) => row.controller_id === null) ? [{ value: NOT_PLACED, label: "Not placed" }] : []),
    ];
    const providers: FilterOption[] = [...new Set(rows.map((row) => row.provider))]
      .map((provider) => ({ value: provider, label: providerLabel(provider) }))
      .sort(byLabel);

    return [
      {
        field: "name",
        headerName: showOwner ? "Agent and owner" : "Agent",
        flex: 1,
        minWidth: 180,
        // Its owner is under its name, so the column filters by owner.
        ...(showOwner && { filter: { value: (row: ManagedAgentTableRow) => row.owner_id, options: owners } }),
        renderCell: ({ row }) => (
          <Stack sx={{ justifyContent: "center", height: "100%", lineHeight: 1.3, overflow: "hidden" }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.display_name ?? row.name}
            </Typography>
            {showOwner && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {row.owner_name}
              </Typography>
            )}
          </Stack>
        ),
      },
      ...(showWorkspace
        ? [
            {
              field: "workspace_name",
              headerName: "Workspace",
              width: 150,
              filter: { value: (row: ManagedAgentTableRow) => row.workspace_name ?? "", options: workspaces },
            } satisfies TableColumn<ManagedAgentTableRow>,
          ]
        : []),
      {
        field: "provider",
        headerName: "Agent provider",
        width: 150,
        filter: { value: (row) => row.provider, options: providers },
        valueGetter: (_value, row) => providerLabel(row.provider),
      },
      {
        field: "controller_name",
        headerName: "Device",
        flex: 1,
        minWidth: 150,
        filter: { value: (row) => row.controller_id ?? NOT_PLACED, options: devices },
        valueGetter: (_value, row) => row.controller_name ?? "Not placed",
      },
      {
        field: "desired_state",
        headerName: "Wanted",
        width: 110,
        renderCell: ({ row }) => <Chip size="small" variant="outlined" label={row.desired_state} />,
      },
      {
        field: "process",
        headerName: "Actual",
        width: 160,
        valueGetter: (_value, row) => actualState(row)?.label ?? "",
        renderCell: ({ row }) => {
          const actual = actualState(row);
          if (actual === null) return EM_DASH;
          return (
            <Tooltip title={actual.detail}>
              <Chip size="small" color={actual.color} label={actual.label} />
            </Tooltip>
          );
        },
      },
      {
        field: "actions",
        headerName: "",
        width: 56,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu
            label={`Actions for ${row.display_name ?? row.name}`}
            actions={actionsFor(row)}
            tabIndex={tabIndex}
          />
        ),
      },
    ];
  }, [rows, showOwner, showWorkspace, providerLabel, actionsFor]);

  const selectFilters = useMemo<SelectFilter[]>(
    () => [
      ...(showWorkspace ? [{ field: "workspace_name", label: "Workspace", allLabel: "All workspaces" }] : []),
      ...(showOwner ? [{ field: "name", label: "Owner", allLabel: "All owners" }] : []),
      { field: "controller_name", label: "Device", allLabel: "All devices" },
      { field: "provider", label: "Agent provider", allLabel: "All agent providers" },
    ],
    [showOwner, showWorkspace],
  );

  const search = useMemo(
    () => ({
      label: "Search managed agents",
      text: (row: ManagedAgentTableRow) =>
        [row.name, row.display_name ?? "", row.owner_name, row.controller_name ?? "", row.workspace_name ?? ""].join(" "),
    }),
    [],
  );

  if (rows.length === 0) return <>{emptyState}</>;
  return (
    <DataTable
      rows={rows}
      columns={columns}
      height={TABLE_CHROME + ROW * Math.min(rows.length, PAGE_SIZE)}
      pageSize={PAGE_SIZE}
      noun={{ one: "managed agent", other: "managed agents" }}
      search={search}
      selectFilters={selectFilters}
      initialSort={{ field: "name", sort: "asc" }}
      pinnedRight={PINNED}
    />
  );
}

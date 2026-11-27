import CloudOutlined from "@mui/icons-material/CloudOutlined";
import ComputerOutlined from "@mui/icons-material/ComputerOutlined";
import TerminalOutlined from "@mui/icons-material/TerminalOutlined";
import WarningAmberOutlined from "@mui/icons-material/WarningAmberOutlined";
import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { type ReactNode, useMemo } from "react";
import DataTable, { type FilterOption, type SelectFilter, type TableColumn } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import type { DeviceType, WorkspaceDevice } from "../../data/management";
import { EM_DASH, MONO_SX, absoluteTitle, formatRelative } from "../../theme/format";
import type { MachinePresentation } from "@switch-console/chat-ui/model/cloud-machine-state";
import { connectionDetail, deviceProblems } from "./deviceHealth";

/** A device as the table shows it. `cloud` is its owner's cloud machine as
 *  they see it, shown in place of online and offline; `workspace_name` is for
 *  a table across several workspaces. */
export interface DeviceTableRow extends WorkspaceDevice {
  cloud?: MachinePresentation;
  workspace_name?: string;
}

export const DEVICE_TYPES: Record<DeviceType, { label: string; icon: ReactNode }> = {
  computer: { label: "Computer", icon: <ComputerOutlined fontSize="small" /> },
  remote_ssh: { label: "Remote SSH", icon: <TerminalOutlined fontSize="small" /> },
  cloud: { label: "Cloud", icon: <CloudOutlined fontSize="small" /> },
};

const STATES: Record<WorkspaceDevice["state"], { label: string; color: "success" | "default" }> = {
  online: { label: "Online", color: "success" },
  offline: { label: "Offline", color: "default" },
  unknown: { label: "Never connected", color: "default" },
  revoked: { label: "Removed", color: "default" },
};

/** The state the row's chip says, and what it says on hover: when it
 *  connected, or when and why it went. A cloud machine that is not ready
 *  says what it is doing instead. */
export function deviceState(row: DeviceTableRow): { label: string; color: "success" | "warning" | "default"; detail: string } {
  if (row.cloud && row.cloud.label !== "Ready") {
    return {
      label: row.cloud.label,
      color: row.cloud.problem ? "warning" : "default",
      detail: row.cloud.problem ?? `Your cloud device is ${row.cloud.label.toLowerCase()}.`,
    };
  }
  return { ...STATES[row.state], detail: connectionDetail(row) };
}

/** How many agents are placed on it; how many of those run is on hover. */
export function agentsRunning(row: WorkspaceDevice): string {
  return `${row.agents_running} of ${row.agents_total} running`;
}

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);
const NO_PLATFORM = "\u0000no-platform";

function platformOf(row: WorkspaceDevice): string | null {
  return row.platform ? `${row.platform.os} ${row.platform.arch}` : null;
}

/** Kept stable: a fresh array each render would rebuild the grid's columns. */
const PINNED = ["actions"];
const TABLE_CHROME = 108;
const ROW = 56;
const PAGE_SIZE = 25;

/**
 * Devices, each with its owner when `showOwner`, and its workspace when
 * `showWorkspace`: Workspace › Devices shows one workspace's, and
 * Organization › Devices every workspace's. What each row offers is the
 * page's (`actionsFor`), from the row's own `can_*`. A device with something
 * wrong (its controller off the release, a provider not signed in) says so
 * beside its state; its details say the rest.
 */
export default function DevicesTable({
  rows,
  showOwner,
  showWorkspace = false,
  providerLabel,
  actionsFor,
  emptyState,
}: {
  rows: DeviceTableRow[];
  showOwner: boolean;
  showWorkspace?: boolean;
  providerLabel: (provider: string) => string;
  actionsFor: (row: DeviceTableRow) => RowAction[];
  emptyState: ReactNode;
}) {
  const columns = useMemo<TableColumn<DeviceTableRow>[]>(() => {
    const owners: FilterOption[] = [...new Map(rows.map((row) => [row.owner_id, row.owner_name])).entries()]
      .map(([value, label]) => ({ value, label }))
      .sort(byLabel);
    const workspaces: FilterOption[] = [...new Set(rows.flatMap((row) => (row.workspace_name ? [row.workspace_name] : [])))]
      .map((name) => ({ value: name, label: name }))
      .sort(byLabel);
    const states: FilterOption[] = [...new Set(rows.map((row) => deviceState(row).label))]
      .map((label) => ({ value: label, label }))
      .sort(byLabel);
    const platforms: FilterOption[] = [
      ...[...new Set(rows.flatMap((row) => platformOf(row) ?? []))].sort().map((label) => ({ value: label, label })),
      ...(rows.some((row) => platformOf(row) === null) ? [{ value: NO_PLATFORM, label: "Not reported" }] : []),
    ];
    const types: FilterOption[] = (Object.keys(DEVICE_TYPES) as DeviceType[])
      .filter((type) => rows.some((row) => row.type === type))
      .map((type) => ({ value: type, label: DEVICE_TYPES[type].label }));

    return [
      {
        field: "name",
        headerName: "Device",
        flex: 1,
        minWidth: 180,
        // Its owner is under its name, so the column filters by owner.
        ...(showOwner && { filter: { value: (row: DeviceTableRow) => row.owner_id, options: owners } }),
        renderCell: ({ row }) => (
          <Stack sx={{ justifyContent: "center", height: "100%", lineHeight: 1.3, overflow: "hidden" }} title={row.description ?? undefined}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.name}
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
              filter: { value: (row: DeviceTableRow) => row.workspace_name ?? "", options: workspaces },
            } satisfies TableColumn<DeviceTableRow>,
          ]
        : []),
      {
        field: "state",
        headerName: "State",
        width: 180,
        valueGetter: (_value, row) => deviceState(row).label,
        filter: { value: (row) => deviceState(row).label, options: states },
        renderCell: ({ row }) => {
          const state = deviceState(row);
          const problems = deviceProblems(row, providerLabel);
          return (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", height: "100%" }}>
              <Tooltip title={state.detail}>
                <Chip size="small" color={state.color} label={state.label} />
              </Tooltip>
              {problems.length > 0 && (
                <Tooltip title={`Needs attention: ${problems.join(" ")}`}>
                  <WarningAmberOutlined
                    fontSize="small"
                    color="warning"
                    titleAccess={`Needs attention: ${problems.join(" ")}`}
                  />
                </Tooltip>
              )}
            </Stack>
          );
        },
      },
      {
        field: "type",
        headerName: "Type",
        width: 140,
        filter: { value: (row) => row.type, options: types },
        valueGetter: (_value, row) => DEVICE_TYPES[row.type].label,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", height: "100%" }}>
            <Box aria-hidden sx={{ display: "flex", color: "text.secondary" }}>
              {DEVICE_TYPES[row.type].icon}
            </Box>
            <span>{DEVICE_TYPES[row.type].label}</span>
          </Stack>
        ),
      },
      {
        field: "agents_total",
        headerName: "Agents",
        width: 100,
        type: "number",
        align: "left",
        headerAlign: "left",
        renderCell: ({ row }) => (
          <Tooltip title={agentsRunning(row)}>
            <span>{row.agents_total}</span>
          </Tooltip>
        ),
      },
      {
        field: "platform",
        headerName: "Platform",
        width: 150,
        filter: { value: (row) => platformOf(row) ?? NO_PLATFORM, options: platforms },
        valueGetter: (_value, row) => platformOf(row) ?? "",
        renderCell: ({ row }) =>
          row.platform ? (
            <Typography component="span" sx={MONO_SX}>
              {`${row.platform.os} ${row.platform.arch}`}
            </Typography>
          ) : (
            EM_DASH
          ),
      },
      {
        field: "last_seen_at",
        headerName: "Last seen",
        width: 130,
        type: "dateTime",
        valueGetter: (value) => (value ? new Date(value as string) : null),
        renderCell: ({ row }) =>
          row.last_seen_at ? (
            <Tooltip title={absoluteTitle(row.last_seen_at)}>
              <span>{formatRelative(row.last_seen_at)}</span>
            </Tooltip>
          ) : (
            EM_DASH
          ),
      },
      {
        field: "actions",
        headerName: "",
        width: 56,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu label={`Actions for ${row.name}`} actions={actionsFor(row)} tabIndex={tabIndex} />
        ),
      },
    ];
  }, [rows, showOwner, showWorkspace, providerLabel, actionsFor]);

  const selectFilters = useMemo<SelectFilter[]>(
    () => [
      ...(showWorkspace ? [{ field: "workspace_name", label: "Workspace", allLabel: "All workspaces" }] : []),
      ...(showOwner ? [{ field: "name", label: "Owner", allLabel: "All owners" }] : []),
      { field: "state", label: "State", allLabel: "All states" },
      { field: "type", label: "Type", allLabel: "All types" },
      { field: "platform", label: "Platform", allLabel: "All platforms" },
    ],
    [showOwner, showWorkspace],
  );

  const search = useMemo(
    () => ({
      label: "Search devices",
      text: (row: DeviceTableRow) =>
        [row.name, row.description ?? "", row.owner_name, row.workspace_name ?? ""].join(" "),
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
      noun={{ one: "device", other: "devices" }}
      search={search}
      selectFilters={selectFilters}
      initialSort={{ field: "name", sort: "asc" }}
      pinnedRight={PINNED}
    />
  );
}

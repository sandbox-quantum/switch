import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import {
  ApiError,
  HOSTED_SWITCH_FAILED,
  type HostedPeople,
  type HostedPerson,
  type Member,
  type TenantRole,
  fetchFeatureFlagMap,
  fetchHostedPeople,
  fetchMembers,
  removeMember,
  setHostedEnabled,
  updateMemberRole,
} from "../../data/api";
import { formatDate, sentenceCase } from "../../theme/hootFormat";
import { useLoad } from "./useLoad";

type MemberRow = Member & { id: string; hosted?: HostedPerson };

// Only ever opened from the hosted columns (hosted agents v2), so it loads on
// first use and a v1 visitor downloads none of it.
const HostedSwitchDialog = lazy(() => import("./HostedSwitchDialog"));

/** What the admin-only flag read found: whether v2 is on, and the hosted list. */
type HostedView = { hostedV2: boolean; hosted: HostedPeople | null };

const BOX_STATE: Record<NonNullable<HostedPerson["box_state"]>, string> = {
  running: "Running",
  resting: "Resting",
  stopped: "Stopped",
  // The Boxes badge's word (copy doc, "Box state badges"): the switch's note
  // already says who paused them.
  paused: "Paused",
  starting: "Starting",
  stopping: "Stopping",
  // The same word operators see for this state (designer, copy doc W4).
  error: "Can't start",
  retired: "Removed",
};
const MEMORY_BAND: Record<NonNullable<HostedPerson["memory_band"]>, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The Box column: "Turned off" for someone the admin turned off (p05), then
 * the box's own state, or a dash with no box. An operator's pause shows as its
 * own state. */
export function boxLabel(person: HostedPerson | undefined): string {
  if (!person) return "—";
  if (person.box_state === "paused" || person.paused_by_switch === true) return BOX_STATE.paused;
  if (person.hosted === "off") return "Turned off";
  return person.box_state ? BOX_STATE[person.box_state] : "—";
}

/**
 * Whether one person's switch can be used, and the note beside it. An
 * operator's pause wins (spec A2); someone the server itself doesn't admit
 * gets no working switch, since turning them on would change nothing (QA).
 */
export function personSwitch(
  person: Pick<HostedPerson, "paused_by_switch" | "switchable">,
  viewSwitchable: boolean,
): { disabled: boolean; note: string | null } {
  if (person.paused_by_switch === true) {
    return { disabled: true, note: "Paused by Switch (switch disabled)" };
  }
  if (person.switchable === false) {
    return { disabled: true, note: "Not enabled by Switch (switch disabled)" };
  }
  return { disabled: !viewSwitchable, note: null };
}

export const HOSTED_LIST_FAILED =
  "Couldn't load hosted agents for this workspace. Reload the page to try again.";

/** The hosted columns for admins: null when not an admin, when hosted agents
 * v2 is off (Core's `hosted_v2` flag), or when the server has no hosted view
 * (404, or 503 before it's set up), so the page shows the members as before.
 * Members never ask for it (spec A1), and nobody does while v2 is off. */
export async function loadHosted(
  tenantId: string,
  canAdmin: boolean,
  hostedV2: boolean,
): Promise<HostedPeople | null> {
  if (!canAdmin || !hostedV2) return null;
  try {
    const hosted = await fetchHostedPeople(tenantId);
    // An answer that isn't a hosted list (a server without hosted agents
    // that answers this path some other way) shows the members as before.
    return Array.isArray(hosted?.people) ? hosted : null;
  } catch (err) {
    if (err instanceof ApiError && [403, 404, 503].includes(err.status)) return null;
    throw err;
  }
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
 * is shown as is. */
export default function MembersSection({ tenantId, selfId }: Props) {
  const load = useCallback(() => fetchMembers(tenantId), [tenantId]);
  const { data: members, error, loading, refetch } = useLoad(load);
  // Only workspace admins ask for the hosted columns (spec A1).
  const { refresh, canAdminTenant: canAdmin } = useAuth();
  // Core's `hosted_v2` flag is read only for an admin, so everyone else
  // makes exactly the requests main does.
  // The same read decides v2's column layout, so with v2 off (and for anyone
  // but an admin) the columns are main's exactly.
  const loadHostedPeople = useCallback(async (): Promise<HostedView> => {
    if (!canAdmin) return { hostedV2: false, hosted: null };
    const flags = await fetchFeatureFlagMap().catch((): Record<string, boolean> => ({}));
    const hostedV2 = flags.hosted_v2 === true;
    return { hostedV2, hosted: await loadHosted(tenantId, true, hostedV2) };
  }, [tenantId, canAdmin]);
  const {
    data: hostedView,
    error: hostedError,
    refetch: refetchHosted,
  } = useLoad(loadHostedPeople);
  const hosted = hostedView?.hosted ?? null;
  const v2Layout = hostedView?.hostedV2 === true;
  const [switching, setSwitching] = useState<{
    userId: string;
    name: string;
    enabling: boolean;
  } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(
    async (userId: string, action: () => Promise<unknown>, leaving = false) => {
      setBusy(userId);
      setActionError(null);
      try {
        await action();
        if (leaving) {
          // The session is on another workspace now, or none, and the page
          // follows it rather than reading this one's members again.
          await refresh();
          return;
        }
        await refetch();
        // Your own role decides what this page offers you.
        if (userId === selfId) await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [refetch, refresh, selfId],
  );

  const columns = useMemo<GridColDef<MemberRow>[]>(() => {
    const roles: TenantRole[] = ["admin", "member"];
    return [
      v2Layout
        ? {
            field: "name",
            headerName: "Name",
            flex: 1,
            minWidth: 150,
            // Wraps rather than cutting off "(you)" (designer's fix list, item 7).
            renderCell: ({ row }) => (
              <WrappedCell>{row.user_id === selfId ? `${row.name} (you)` : row.name}</WrappedCell>
            ),
          }
        : {
            // With v2 off, main's column exactly.
            field: "name",
            headerName: "Name",
            flex: 1,
            minWidth: 140,
            renderCell: ({ row }) => (row.user_id === selfId ? `${row.name} (you)` : row.name),
          },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: v2Layout ? 190 : 200 },
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
              onChange={(e) =>
                act(row.user_id, () =>
                  updateMemberRole(tenantId, row.user_id, e.target.value as TenantRole),
                )
              }
              aria-label={`Role for ${row.email}`}
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
        width: v2Layout ? 120 : 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      ...(hosted
        ? hostedColumns({
            busy: busy !== null,
            switchable: hosted.switchable === true,
            // Both directions go through the dialog with a reason (the lead's decision).
            onToggle: (row, enabled) => {
              setSwitchError(null);
              setSwitching({ userId: row.user_id, name: row.name, enabling: enabled });
            },
          })
        : []),
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
                  onClick={() =>
                    act(
                      row.user_id,
                      () => removeMember(tenantId, row.user_id),
                      row.user_id === selfId,
                    )
                  }
                  aria-label={row.user_id === selfId ? "Leave this workspace" : `Remove ${row.email}`}
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ];
  }, [act, busy, hosted, v2Layout, selfId, tenantId]);

  const confirmSwitch = useCallback(
    async (reason: string) => {
      if (switching === null) return;
      setBusy(switching.userId);
      setSwitchError(null);
      try {
        await setHostedEnabled(tenantId, switching.userId, switching.enabling, reason);
        await refetchHosted();
        setSwitching(null);
      } catch (err) {
        // `setHostedEnabled` only ever throws one of its fixed messages.
        setSwitchError(err instanceof Error ? err.message : HOSTED_SWITCH_FAILED);
      } finally {
        setBusy(null);
      }
    },
    [refetchHosted, tenantId, switching],
  );

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Users</Typography>
      {hosted && (
        <Typography variant="body2" color="text.secondary">
          Admins can change roles, remove people, and turn hosted agents on or off for each person. Every change is recorded.
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {/* A fixed line, never the server's text: the plain members list still shows below it. */}
      {canAdmin && hostedError && (
        <Alert severity="warning">{HOSTED_LIST_FAILED}</Alert>
      )}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        <>
        <DataTable
          rows={(members ?? []).map((m) => ({
            ...m,
            id: m.user_id,
            hosted: hosted?.people.find((person) => person.user_id === m.user_id),
          }))}
          columns={columns}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
        {hosted && (
          <Typography variant="body2" color="text.secondary">
            Memory is shown as a band. This page shows states and counts only, never what anyone's agents are doing or saying.
          </Typography>
        )}
        </>
      )}
      {hosted && (
        <Suspense fallback={null}>
          <HostedSwitchDialog
            key={switching ? `${switching.userId}-${switching.enabling}` : "closed"}
            open={switching !== null}
            enabling={switching?.enabling ?? false}
            personName={switching?.name ?? ""}
            busy={busy !== null}
            error={switchError}
            onCancel={() => setSwitching(null)}
            onConfirm={(reason) => void confirmSwitch(reason)}
          />
        </Suspense>
      )}
    </Stack>
  );
}

/** A cell whose text wraps onto a second line instead of being cut off. */
function WrappedCell({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", height: "100%" }}>
      <Typography variant="body2" sx={{ whiteSpace: "normal", lineHeight: 1.3, fontSize: "inherit" }}>
        {children}
      </Typography>
    </Box>
  );
}

/** Visibility V4 (spec A1): hosted agents on or off, agents, box state, memory
 * band and last active, for workspace admins only. */
function hostedColumns({
  busy,
  switchable,
  onToggle,
}: {
  busy: boolean;
  /** False until V3's switch exists: then the switch shows read-only. */
  switchable: boolean;
  onToggle: (row: MemberRow, enabled: boolean) => void;
}): GridColDef<MemberRow>[] {
  const dash = (value: string | null | undefined) => value ?? "—";
  return [
    {
      field: "hosted_on",
      headerName: "Hosted agents",
      width: 230,
      sortable: false,
      renderCell: ({ row }) => {
        if (!row.hosted) return "—";
        const { disabled, note } = personSwitch(row.hosted, switchable);
        return (
          // Full cell height, so the switch and its note sit on the row's centre line.
          <Stack direction="row" alignItems="center" spacing={1} sx={{ height: "100%" }}>
            <Switch
              size="small"
              checked={row.hosted.hosted === "on"}
              disabled={busy || disabled}
              onChange={(e) => onToggle(row, e.target.checked)}
              slotProps={{ input: { "aria-label": `Hosted agents for ${row.email}` } }}
            />
            {note && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: "normal", lineHeight: 1.3 }}
              >
                {note}
              </Typography>
            )}
          </Stack>
        );
      },
    },
    {
      field: "hosted_agents",
      headerName: "Agents",
      width: 90,
      sortable: false,
      valueGetter: (_value, row) => row.hosted?.agents ?? "—",
    },
    {
      field: "hosted_box",
      headerName: "Box",
      width: 120,
      sortable: false,
      valueGetter: (_value, row) => boxLabel(row.hosted),
      // Paused shows as the Boxes tab's red badge; every other state as text.
      renderCell: ({ value }) =>
        value === BOX_STATE.paused ? (
          <Chip size="small" color="error" variant="outlined" label={value} />
        ) : (
          value
        ),
    },
    {
      field: "hosted_memory",
      headerName: "Memory",
      width: 110,
      sortable: false,
      valueGetter: (_value, row) =>
        dash(row.hosted?.memory_band ? MEMORY_BAND[row.hosted.memory_band] : null),
    },
    {
      field: "hosted_last_active",
      headerName: "Last active",
      width: 140,
      sortable: false,
      valueGetter: (_value, row) =>
        row.hosted?.last_active_at ? formatDate(row.hosted.last_active_at) : "—",
    },
  ];
}

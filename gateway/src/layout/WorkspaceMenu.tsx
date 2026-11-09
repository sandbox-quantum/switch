import CheckOutlined from "@mui/icons-material/CheckOutlined";
import PersonAddOutlined from "@mui/icons-material/PersonAddOutlined";
import {
  Alert,
  Box,
  Divider,
  ListSubheader,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { type WorkspaceCounts, fetchWorkspaceCounts } from "../data/api";
import { useAuth } from "../data/AuthContext";
import {
  type OrganizationName,
  countsLabel,
  switcherSections,
  switcherWorkspaces,
} from "../data/workspaceSwitcher";

type CountsState =
  | { status: "loading" }
  | { status: "loaded"; byId: Map<string, WorkspaceCounts> }
  | { status: "failed"; message: string };

/** The workspace switcher the top bar's breadcrumb opens: the workspaces this
 * person may enter, by organization, with how many users and agents each
 * has, read when it opens. An admin of the current workspace may invite
 * people to it from here. */
export default function WorkspaceMenu({
  anchor,
  onClose,
  organizations,
  organizationsError,
  onSwitch,
  onInvite,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  organizations: OrganizationName[];
  organizationsError: string | null;
  onSwitch: (tenantId: string) => void;
  onInvite: () => void;
}) {
  const { session, capabilities } = useAuth();
  const open = anchor !== null;
  const [counts, setCounts] = useState<CountsState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCounts({ status: "loading" });
    fetchWorkspaceCounts().then(
      (rows) => {
        if (!cancelled) setCounts({ status: "loaded", byId: new Map(rows.map((r) => [r.id, r])) });
      },
      (err: unknown) => {
        if (!cancelled) {
          setCounts({
            status: "failed",
            message: err instanceof Error ? err.message : "Could not load the counts",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const current = session?.tenant ?? null;
  const { sections, headed } = switcherSections(
    switcherWorkspaces(current, session?.tenants ?? []),
    organizations,
  );

  const countsOf = (id: string): string => {
    if (counts.status === "loading") return "…";
    if (counts.status === "failed") return "";
    const found = counts.byId.get(id);
    return found === undefined ? "" : countsLabel(found);
  };

  return (
    <Menu
      anchorEl={anchor}
      open={open}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: "top", horizontal: "left" }}
      slotProps={{ paper: { sx: { width: 300, p: 0.5 } }, list: { "aria-label": "Workspaces" } }}
    >
      {organizationsError !== null && (
        <Alert severity="warning" sx={{ mx: 0.5, mb: 0.5 }}>
          Could not load the organizations' names: {organizationsError}
        </Alert>
      )}
      {counts.status === "failed" && (
        <Alert severity="warning" sx={{ mx: 0.5, mb: 0.5 }}>
          Could not load how many users and agents each workspace has: {counts.message}
        </Alert>
      )}
      {sections.flatMap((section) => [
        ...(headed
          ? [
              <ListSubheader
                key={`organization:${section.organizationId ?? "none"}`}
                sx={{ lineHeight: "32px", backgroundColor: "transparent" }}
              >
                {section.name ?? "No organization"}
              </ListSubheader>,
            ]
          : []),
        ...section.workspaces.map((workspace) => {
          const isCurrent = workspace.id === current?.id;
          return (
            <MenuItem
              key={workspace.id}
              selected={isCurrent}
              aria-current={isCurrent ? "true" : undefined}
              onClick={() => (isCurrent ? onClose() : onSwitch(workspace.id))}
              sx={{ gap: 1, borderRadius: 1 }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
                  {workspace.name}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                  {countsOf(workspace.id)}
                </Typography>
              </Box>
              {isCurrent && <CheckOutlined sx={{ fontSize: 16 }} />}
            </MenuItem>
          );
        }),
      ])}
      {capabilities.administersWorkspace && current !== null && [
        <Divider key="divider" sx={{ my: 0.5 }} />,
        <MenuItem key="invite" onClick={onInvite} sx={{ gap: 1, borderRadius: 1 }}>
          <PersonAddOutlined sx={{ fontSize: 16 }} />
          Invite people to {current.name}
        </MenuItem>,
      ]}
    </Menu>
  );
}

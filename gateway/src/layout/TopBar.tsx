import ChevronLeftOutlined from "@mui/icons-material/ChevronLeftOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import HelpOutlineOutlined from "@mui/icons-material/HelpOutlineOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import { Alert, Box, Button, IconButton, Snackbar, Stack, Tooltip, Typography } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router";
import { useAuth } from "../data/AuthContext";
import { useOrganizationRenamed } from "../data/organizationEvents";
import {
  type OrganizationName,
  loadOrganizationNames,
  organizationName,
} from "../data/workspaceSwitcher";
import CreateInvitationDialog from "../pages/workspace/CreateInvitationDialog";
import { areaOf, outsideWorkspace, underAreaOutsideWorkspace } from "../routes/routeTable";
import { DevRoleSlot } from "./DevRoleSlot";
import { useWayBackToWorkspace } from "./wayBack";
import WorkspaceMenu from "./WorkspaceMenu";

const SECTION_LABELS: [prefix: string, label: string][] = [
  ["/overview", "Home"],
  ["/ecosystem", "Ecosystem"],
  ["/agents", "Agents"],
  ["/rooms", "Rooms"],
  ["/templates", "Templates"],
  ["/connectors", "Connectors"],
  ["/resources", "Resources"],
  ["/usage", "Usage & budget"],
  ["/settings/org", "Organization settings"],
  ["/settings", "Settings"],
];

const DOCS_URL = "https://docs.switchagents.ai/switch-rooms/getting-started";
const HELP_URL = "https://docs.switchagents.ai/switch-rooms/resources/troubleshooting";

const CRUMB_TEXT = { fontSize: "0.9375rem", fontWeight: 500, letterSpacing: "-0.02em" };

function Separator() {
  return (
    <Box component="span" sx={{ opacity: 0.4, mx: 1 }}>
      /
    </Box>
  );
}

function PageLabel({ label }: { label: string | undefined }) {
  if (label === undefined) return null;
  return (
    <>
      <Separator />
      <Box component="span" sx={{ fontWeight: 700 }}>
        {label}
      </Box>
    </>
  );
}

/** The breadcrumb: "Organization / Workspace", which opens the
 * workspace switcher, then the page. In an area outside the workspace,
 * organization settings or Platform, the way back to it instead: back to the
 * page it was entered from, or, when it was opened directly, from
 * organization settings to workspace settings and from Platform home. */
function WorkspaceCrumbs({
  section,
  outside,
  wayBack,
  fallback,
}: {
  section: string | undefined;
  outside: boolean;
  wayBack: { href: string; delta: number } | null;
  fallback: string;
}) {
  const { session, switchTo } = useAuth();
  const navigate = useNavigate();
  const [organizations, setOrganizations] = useState<OrganizationName[]>([]);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const tenant = session?.tenant ?? null;
  const currentOrganizationId = tenant?.organization_id ?? null;
  // Bumped when the organization is renamed, so its name is read again.
  const [renames, setRenames] = useState(0);
  useOrganizationRenamed(useCallback(() => setRenames((n) => n + 1), []));
  useEffect(() => {
    let cancelled = false;
    loadOrganizationNames(currentOrganizationId).then(
      (rows) => {
        if (!cancelled) setOrganizations(rows);
      },
      (err: unknown) => {
        if (!cancelled) {
          setOrganizationsError(err instanceof Error ? err.message : "Could not load them");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentOrganizationId, renames]);

  const switchWorkspace = async (tenantId: string) => {
    setAnchor(null);
    try {
      await switchTo(tenantId);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "Could not switch workspace");
    }
  };

  const organization = organizationName(currentOrganizationId, organizations);

  let crumbs: ReactNode;
  if (outside) {
    crumbs = (
      <Button
        component={RouterLink}
        to={wayBack?.href ?? fallback}
        onClick={(e: MouseEvent<HTMLElement>) => {
          if (wayBack === null || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            return;
          }
          e.preventDefault();
          void navigate(wayBack.delta);
        }}
        color="inherit"
        startIcon={<ChevronLeftOutlined sx={{ fontSize: 18 }} />}
        sx={{ ...CRUMB_TEXT, px: 1 }}
      >
        Back to workspace
      </Button>
    );
  } else {
    crumbs = (
      <Button
        color="inherit"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)}
        endIcon={<ExpandMoreOutlined sx={{ fontSize: 18 }} />}
        sx={{ ...CRUMB_TEXT, px: 1, textTransform: "none", minWidth: 0 }}
      >
        {organization !== null && (
          <>
            {organization}
            <Separator />
          </>
        )}
        <Box component="span" sx={{ fontWeight: 700 }}>
          {tenant?.name}
        </Box>
      </Button>
    );
  }

  return (
    <Stack direction="row" sx={{ alignItems: "center", px: 1, minWidth: 0 }}>
      {crumbs}
      <Typography component="span" sx={CRUMB_TEXT}>
        <PageLabel label={section} />
      </Typography>

      <WorkspaceMenu
        anchor={anchor}
        onClose={() => setAnchor(null)}
        organizations={organizations}
        organizationsError={organizationsError}
        onSwitch={switchWorkspace}
        onInvite={() => {
          setAnchor(null);
          setInviteOpen(true);
        }}
      />
      {tenant !== null && (
        <CreateInvitationDialog
          open={inviteOpen}
          tenantId={tenant.id}
          fromOrganization={false}
          workspaceName={tenant.name}
          emailEnabled={session?.invite_email_enabled ?? false}
          onClose={() => setInviteOpen(false)}
        />
      )}
      <Snackbar
        open={switchError !== null}
        onClose={() => setSwitchError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Alert severity="error" onClose={() => setSwitchError(null)}>
          {switchError}
        </Alert>
      </Snackbar>
    </Stack>
  );
}

function LinkButton({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <Tooltip title={label}>
      <IconButton color="inherit" href={href} target="_blank" rel="noreferrer" aria-label={label}>
        {icon}
      </IconButton>
    </Tooltip>
  );
}

export default function TopBar() {
  const { pathname } = useLocation();
  const { capabilities } = useAuth();
  const outside = outsideWorkspace(pathname, capabilities);
  // A refused page or a missing one under an area outside the workspace is
  // shown in the workspace's chrome, where the area's name would read as if
  // it had been entered.
  const section =
    !outside && underAreaOutsideWorkspace(pathname)
      ? undefined
      : SECTION_LABELS.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  const fallback = areaOf(pathname) === "organization" ? "/settings" : "/";
  const wayBack = useWayBackToWorkspace();

  return (
    <Stack
      direction="row"
      sx={{
        height: "var(--top-bar-height)",
        alignItems: "center",
        justifyContent: "space-between",
        color: "text.primary",
        pr: 1,
      }}
    >
      <WorkspaceCrumbs section={section} outside={outside} wayBack={wayBack} fallback={fallback} />

      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <DevRoleSlot />
        <LinkButton href={HELP_URL} icon={<HelpOutlineOutlined sx={{ fontSize: 20 }} />} label="Help" />
        <LinkButton
          href={DOCS_URL}
          icon={<MenuBookOutlined sx={{ fontSize: 20 }} />}
          label="Documentation"
        />
      </Stack>
    </Stack>
  );
}

import ChevronLeftOutlined from "@mui/icons-material/ChevronLeftOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import HelpOutlineOutlined from "@mui/icons-material/HelpOutlineOutlined";
import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import { Alert, Box, Button, Snackbar, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import {
  type OrganizationName,
  loadOrganizationNames,
  organizationName,
} from "../data/workspaceSwitcher";
import CreateInvitationDialog from "../pages/workspace/CreateInvitationDialog";
import { type Layout, areaOf } from "../routes/routeTable";
import { DevRoleSlot } from "./DevRoleSlot";
import WorkspaceMenu from "./WorkspaceMenu";

const SECTION_LABELS: [prefix: string, label: string][] = [
  ["/ecosystem", "Ecosystem"],
  ["/rooms", "Rooms"],
  ["/resources", "Resources"],
  ["/agents", "Agents"],
  ["/collaborations", "Messaging apps"],
  ["/registration-keys", "API keys"],
  ["/machines", "Devices"],
  ["/connectors", "Connectors"],
  ["/users", "Users"],
  ["/workspace", "Workspace"],
  ["/organization", "Organization"],
  ["/operator/workspaces", "All workspaces"],
  ["/usage", "Usage"],
  // The new layout's own (`gateway_v2`).
  ["/overview", "Overview"],
  ["/templates", "Templates"],
  ["/settings/org", "Organization settings"],
  ["/settings", "Settings"],
  ["/platform", "Platform"],
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

/** Today's breadcrumb: Switch, the workspace, the page. */
function CurrentCrumbs({ section }: { section: string | undefined }) {
  const { session } = useAuth();
  const crumbs = [session?.tenant?.name, section].filter(
    (crumb): crumb is string => Boolean(crumb),
  );
  return (
    <Typography sx={{ ...CRUMB_TEXT, px: 2 }}>
      Switch
      {crumbs.map((crumb, i) => (
        <Box component="span" key={i}>
          <Separator />
          <Box component="span" sx={{ fontWeight: i === crumbs.length - 1 ? 700 : 500 }}>
            {crumb}
          </Box>
        </Box>
      ))}
    </Typography>
  );
}

/** The new layout's breadcrumb: "Organization / Workspace", which opens the
 * workspace switcher, then the page. In organization settings, the way back
 * to the workspace instead. */
function WorkspaceCrumbs({
  section,
  inOrganizationSettings,
}: {
  section: string | undefined;
  inOrganizationSettings: boolean;
}) {
  const { session, switchTo } = useAuth();
  const [organizations, setOrganizations] = useState<OrganizationName[]>([]);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const tenant = session?.tenant ?? null;
  const currentOrganizationId = tenant?.organization_id ?? null;
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
  }, [currentOrganizationId]);

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
  if (inOrganizationSettings) {
    crumbs = (
      <Button
        component={RouterLink}
        to="/"
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
            <Box component="span" sx={{ color: "text.secondary" }}>
              {organization}
            </Box>
            <Separator />
          </>
        )}
        {tenant?.name}
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

function LinkButton({ href, icon, children }: { href: string; icon: ReactNode; children: string }) {
  return (
    <Button
      color="inherit"
      href={href}
      target="_blank"
      rel="noreferrer"
      startIcon={icon}
      sx={{ fontWeight: 500 }}
    >
      {children}
    </Button>
  );
}

export default function TopBar({ layout }: { layout: Layout }) {
  const { pathname } = useLocation();
  const section = SECTION_LABELS.find(([prefix]) => pathname.startsWith(prefix))?.[1];

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
      {layout === "v2" ? (
        <WorkspaceCrumbs
          section={section}
          inOrganizationSettings={areaOf(pathname, layout) === "organization"}
        />
      ) : (
        <CurrentCrumbs section={section} />
      )}

      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <DevRoleSlot />
        {layout === "v2" && (
          <LinkButton href={HELP_URL} icon={<HelpOutlineOutlined sx={{ fontSize: 18 }} />}>
            Help
          </LinkButton>
        )}
        <LinkButton href={DOCS_URL} icon={<MenuBookOutlined sx={{ fontSize: 18 }} />}>
          Docs
        </LinkButton>
      </Stack>
    </Stack>
  );
}

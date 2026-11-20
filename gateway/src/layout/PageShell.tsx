import { Alert, Box, Button, Stack } from "@mui/material";
import { type ReactNode, Suspense, lazy } from "react";
import { Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import { AGENT_MANAGEMENT, GATEWAY_CHATS, GATEWAY_ONBOARDING } from "../data/featureFlags";
import { GET_STARTED, sentToGetStarted } from "../pages/get-started/paths";
import { FULL_WINDOW } from "../routes/roleMatrix";
import { AREAS, enteredArea } from "../routes/routeTable";
import LinkNoticeBanner from "./LinkNoticeBanner";
import NavRail from "./NavRail";
import PageErrorBoundary from "./PageErrorBoundary";
import TopBar from "./TopBar";

// Loaded only on a server with chats in the dashboard: it carries the chat UI.
const WebChatHost = lazy(() => import("../pages/chats/WebChatHost"));

// Loaded only on a server with getting started on the web.
const CloudWarmUp = lazy(() => import("../pages/get-started/CloudWarmUp"));

/** Warms the person's cloud device under every page, where the server has getting started on the web. */
function WarmUp() {
  const { capabilities } = useAuth();
  if (!capabilities.features[GATEWAY_ONBOARDING]) return null;
  return (
    <Suspense fallback={null}>
      <CloudWarmUp />
    </Suspense>
  );
}

const FirstVisitGate = lazy(() =>
  import("../pages/get-started/CloudWarmUp").then((module) => ({ default: module.FirstVisitGate })),
);

/**
 * On an arrival that may be someone's first, where the server has getting
 * started on the web, shows nothing until it is known whether to open Get
 * started, so they land there rather than on Home first.
 */
function FirstVisit({ children }: { children: ReactNode }) {
  const { user, session, capabilities } = useAuth();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;
  const tenantId = session?.tenant?.id ?? null;
  const deciding =
    capabilities.features[GATEWAY_ONBOARDING] === true &&
    capabilities.features[AGENT_MANAGEMENT] === true &&
    userId !== null &&
    tenantId !== null &&
    pathname !== GET_STARTED &&
    !sentToGetStarted(userId, tenantId);
  if (!deciding) return <>{children}</>;
  return (
    <Suspense fallback={null}>
      <FirstVisitGate>{children}</FirstVisitGate>
    </Suspense>
  );
}

/** Keeps the person's chats live under every page, where the server has them. */
function WithChats({ children }: { children: ReactNode }) {
  const { capabilities } = useAuth();
  if (!capabilities.features[GATEWAY_CHATS]) return <>{children}</>;
  return (
    <Suspense fallback={children}>
      <WebChatHost>{children}</WebChatHost>
    </Suspense>
  );
}

/** The signature shell: a narrow icon rail and a slim top bar sitting bare on
 *  the warm canvas, framing a single rounded content surface. Chrome recedes so
 *  the content is the hero — an "app within a surface", not edge-to-edge chrome.
 *  Organization settings are a place of their own, outside the workspace: no
 *  rail there, and the top bar leads back. A settings area draws its own title
 *  bar, menu and padding across the whole surface; one refused is shown like
 *  any other page. */
export default function PageShell() {
  return (
    <FirstVisit>
      <Shell />
    </FirstVisit>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const { capabilities } = useAuth();
  const area = enteredArea(pathname, capabilities);
  const withRail = area === null || !AREAS[area].outsideWorkspace;
  if (FULL_WINDOW.includes(pathname))
    return (
      <Box component="main" sx={{ height: "100vh" }}>
        <PageErrorBoundary resetKey={pathname}>
          <Outlet />
        </PageErrorBoundary>
      </Box>
    );
  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "var(--sw-canvas)",
      }}
    >
      {withRail && <NavRail />}
      <Stack
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          pl: withRail ? 0 : "var(--surface-gutter)",
          pr: "var(--surface-gutter)",
          pb: "var(--surface-gutter)",
        }}
      >
        <TopBar />
        <Stack
          component="main"
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            borderRadius: "16px",
            backgroundColor: "background.paper",
            color: "text.primary",
            boxShadow: "var(--sw-shadow-surface)",
            ...(area === null ? { p: 4 } : { overflowY: "hidden" }),
          }}
        >
          <Box sx={area === null ? undefined : { px: 3, pt: 3, "&:empty": { display: "none" } }}>
            <WarmUp />
            <WorkspaceMismatchBanner />
            <StaleSessionBanner />
            <LinkNoticeBanner />
          </Box>
          <PageErrorBoundary resetKey={pathname}>
            <WithChats>
              <Outlet />
            </WithChats>
          </PageErrorBoundary>
        </Stack>
      </Stack>
    </Box>
  );
}

/** Says so when the session could not be read again on coming back to the
 * tab, rather than carrying on as if what the page shows were current. */
function StaleSessionBanner() {
  const { staleError, recheck } = useAuth();
  if (staleError === null) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => void recheck()}>
          Retry
        </Button>
      }
    >
      Could not check your session with Switch: {staleError}. This page may be out of date.
    </Alert>
  );
}

/** Says so when the server refused a write because another tab moved the
 * session to another workspace: everything this page shows is the old one's,
 * so the way on is to reload it. */
export function WorkspaceMismatchBanner() {
  const { workspaceMismatch } = useAuth();
  if (workspaceMismatch === null) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      {workspaceMismatch}
    </Alert>
  );
}

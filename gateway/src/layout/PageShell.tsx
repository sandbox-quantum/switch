import { Alert, Box, Button, Stack } from "@mui/material";
import { Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import { AREAS, enteredArea } from "../routes/routeTable";
import LinkNoticeBanner from "./LinkNoticeBanner";
import NavRail from "./NavRail";
import TopBar from "./TopBar";

/** Switch Rooms' brand-blue wash, from the top left. Light theme only: on dark
 *  it reads as a colour cast, so dark keeps its flat canvas. */
const SHELL_WASH =
  "radial-gradient(ellipse 80% 100% at 14% 0%, color-mix(in oklch, var(--sw-brand-blue) 28%, transparent) 0%, color-mix(in oklch, var(--sw-brand-blue) 10%, transparent) 100%)";

/** The signature shell: a slim top bar across the top and a narrow icon rail
 *  beneath it, sitting bare on the canvas, framing a single rounded content
 *  surface. Chrome recedes so the content is the hero — an "app within a surface", not edge-to-edge chrome.
 *  Organization settings are a place of their own, outside the workspace: no
 *  rail there, and the top bar leads back. A settings area draws its own title
 *  bar, menu and padding across the whole surface; one refused is shown like
 *  any other page. */
export default function PageShell() {
  const { pathname } = useLocation();
  const { capabilities } = useAuth();
  const area = enteredArea(pathname, capabilities);
  const withRail = area === null || !AREAS[area].outsideWorkspace;
  return (
    <Stack
      sx={{
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "var(--sw-brand-clarity-white)",
        backgroundImage: SHELL_WASH,
        '[data-mui-color-scheme="dark"] &': {
          backgroundColor: "var(--sw-canvas)",
          backgroundImage: "none",
        },
      }}
    >
      <TopBar />
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        {withRail && <NavRail />}
        <Stack
          component="main"
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
            ml: withRail ? 0 : "var(--surface-gutter)",
            mr: "var(--surface-gutter)",
            mb: "var(--surface-gutter)",
            borderRadius: "16px",
            backgroundColor: "background.paper",
            color: "text.primary",
            boxShadow: "var(--sw-shadow-surface)",
            ...(area === null ? { p: 4 } : { overflowY: "hidden" }),
          }}
        >
          <Box sx={area === null ? undefined : { px: 3, pt: 3, "&:empty": { display: "none" } }}>
            <WorkspaceMismatchBanner />
            <StaleSessionBanner />
            <LinkNoticeBanner />
          </Box>
          <Outlet />
        </Stack>
      </Box>
    </Stack>
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

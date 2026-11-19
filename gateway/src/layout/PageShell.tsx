import { Alert, Box, Button, Stack } from "@mui/material";
import { Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import { AREAS, enteredArea } from "../routes/routeTable";
import LinkNoticeBanner from "./LinkNoticeBanner";
import NavRail from "./NavRail";
import TopBar from "./TopBar";

/** The signature shell: a narrow icon rail and a slim top bar sitting bare on
 *  the warm canvas, framing a single rounded content surface. Chrome recedes so
 *  the content is the hero — an "app within a surface", not edge-to-edge chrome.
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
            <WorkspaceMismatchBanner />
            <StaleSessionBanner />
            <LinkNoticeBanner />
          </Box>
          <Outlet />
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

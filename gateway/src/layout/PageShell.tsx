import { Alert, Box, Button, Stack } from "@mui/material";
import { Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import { type Layout, areaOf } from "../routes/routeTable";
import NavRail from "./NavRail";
import TopBar from "./TopBar";

/** Hoot's signature shell: a narrow icon rail and a slim top bar sitting bare on
 *  the warm canvas, framing a single rounded content surface. Chrome recedes so
 *  the content is the hero — an "app within a surface", not edge-to-edge chrome.
 *  The new layout's organization settings are a place of their own, outside
 *  the workspace: no rail there, and the top bar leads back. */
export default function PageShell({ layout }: { layout: Layout }) {
  const { pathname } = useLocation();
  const withRail = areaOf(pathname, layout) !== "organization";
  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "var(--hoot-canvas)",
      }}
    >
      {withRail && <NavRail layout={layout} />}
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
        <TopBar layout={layout} />
        <Stack
          component="main"
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            borderRadius: "16px",
            backgroundColor: "background.paper",
            color: "text.primary",
            boxShadow: "var(--hoot-shadow-surface)",
            p: 4,
          }}
        >
          <StaleSessionBanner />
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
        <Button color="inherit" size="small" onClick={recheck}>
          Retry
        </Button>
      }
    >
      Could not check your session with Switch: {staleError}. This page may be out of date.
    </Alert>
  );
}

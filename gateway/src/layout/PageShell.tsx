import { Box, Stack } from "@mui/material";
import { Outlet } from "react-router";
import NavRail from "./NavRail";
import TopBar from "./TopBar";

/** Hoot's signature shell: a narrow icon rail and a slim top bar sitting bare on
 *  the warm canvas, framing a single rounded content surface. Chrome recedes so
 *  the content is the hero — an "app within a surface", not edge-to-edge chrome. */
export default function PageShell() {
  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "var(--hoot-canvas)",
      }}
    >
      <NavRail />
      <Stack sx={{ flex: 1, minWidth: 0, overflow: "hidden", pr: "var(--surface-gutter)", pb: "var(--surface-gutter)" }}>
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
            boxShadow: "var(--hoot-shadow-surface)",
            p: 4,
          }}
        >
          <Outlet />
        </Stack>
      </Stack>
    </Box>
  );
}

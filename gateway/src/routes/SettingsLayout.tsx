import { Box, List, ListItemButton, ListItemText, Stack, Typography } from "@mui/material";
import { useEffect } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import {
  type SettingsArea,
  clearLandingAfterSwitch,
  landingCarriedAcross,
  rememberedSettingsPage,
  rememberSettingsPage,
} from "../data/settingsLanding";
import { AREAS, type Layout, accessTo, menuOf } from "./routeTable";
import { NoAccessPage } from "./StatusPages";

/** A settings area: its section menu beside the page. The menu lists only the
 * pages this person may open; the area remembers the page they were on. Who
 * may enter the area at all is checked here, so a refused area shows no menu
 * of pages they cannot use. */
export function SettingsLayout({ area, layout }: { area: SettingsArea; layout: Layout }) {
  const { capabilities } = useAuth();
  const { pathname } = useLocation();
  const definition = AREAS[area];
  const entry = definition.access(capabilities);
  const allowedHere = accessTo(pathname, layout, capabilities)?.allowed === true;

  useEffect(() => {
    if (entry.allowed && allowedHere) rememberSettingsPage(area, pathname);
  }, [area, pathname, entry.allowed, allowedHere]);

  if (!entry.allowed) return <NoAccessPage access={entry} />;

  const menu = menuOf(area, layout, capabilities);
  const organization = accessTo("/settings/org", layout, capabilities)?.allowed === true;
  const otherArea =
    area === "workspace" && organization
      ? { label: "Organization settings ›", path: "/settings/org" }
      : area === "organization"
        ? { label: "‹ Workspace settings", path: "/settings" }
        : null;

  return (
    <Stack direction="row" spacing={4} sx={{ minHeight: 0, flexGrow: 1 }}>
      <Box component="nav" aria-label={definition.title} sx={{ width: 220, flexShrink: 0 }}>
        <Typography variant="overline" sx={{ color: "text.secondary", px: 2 }}>
          {definition.title}
        </Typography>
        <List dense>
          {menu.map((item) => (
            <ListItemButton
              key={item.path}
              component={NavLink}
              to={item.path}
              selected={pathname === item.path}
              sx={{ borderRadius: 1 }}
            >
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
          {otherArea !== null && (
            <ListItemButton component={NavLink} to={otherArea.path} sx={{ borderRadius: 1, mt: 1 }}>
              <ListItemText primary={otherArea.label} />
            </ListItemButton>
          )}
        </List>
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Outlet />
      </Box>
    </Stack>
  );
}

/** An area opened without naming a page. After a workspace switch from a
 * settings page, that page; otherwise the page last open in the area. Either
 * only when this person may open it in this workspace, and the area's first
 * page when not, so a switch or a change of role never lands someone on a
 * page they cannot use. A page named in the URL is different: it shows why it
 * is refused (`Guarded`). */
export function SettingsIndex({ area, layout }: { area: SettingsArea; layout: Layout }) {
  const { capabilities } = useAuth();
  const definition = AREAS[area];
  const entry = definition.access(capabilities);
  // Only the workspace area is where a switch lands.
  const carried = area === "workspace" ? landingCarriedAcross() : null;
  useEffect(() => {
    if (area === "workspace") clearLandingAfterSwitch();
  }, [area]);

  if (!entry.allowed) return <NoAccessPage access={entry} />;

  const candidates = [carried, rememberedSettingsPage(area)].filter(
    (path): path is string => path !== null,
  );
  const landing =
    candidates.find((path) => accessTo(path, layout, capabilities)?.allowed === true) ??
    definition.first;
  return <Navigate to={landing} replace />;
}

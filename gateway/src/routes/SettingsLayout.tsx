import ChevronRight from "@mui/icons-material/ChevronRight";
import {
  Box,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";
import {
  type SettingsArea,
  clearLandingAfterSwitch,
  landingCarriedAcross,
  rememberedSettingsPage,
  rememberSettingsPage,
} from "../data/settingsLanding";
import { AREAS, accessTo, menuOf } from "./routeTable";
import { NoAccessPage } from "./StatusPages";

/** A settings area: a title bar naming it across the surface, and its
 * section menu, in a column of its own that scrolls on its own, beside the
 * page. The menu lists only the pages this person may open; the area
 * remembers the page they were on. Who may enter the area at all is checked
 * here, so a refused area shows no menu of pages they cannot use.
 *
 * Each group of the menu sits below a rule: the area's own pages, headed
 * "This workspace" in the workspace's area, then the pages about the person
 * (Your account), then, for an organization admin, the way into organization
 * settings, which leaves this area. Organization settings has no way back in
 * its menu: the top bar's "Back to workspace" is the one way out. */
export function SettingsLayout({ area }: { area: SettingsArea }) {
  const { capabilities } = useAuth();
  const { pathname } = useLocation();
  const definition = AREAS[area];
  const entry = definition.access(capabilities);
  const allowedHere = accessTo(pathname, capabilities)?.allowed === true;

  useEffect(() => {
    if (entry.allowed && allowedHere) rememberSettingsPage(area, pathname);
  }, [area, pathname, entry.allowed, allowedHere]);

  if (!entry.allowed) return <NoAccessPage access={entry} />;

  const menu = menuOf(area, capabilities);
  const own = menu.filter((item) => !item.personal);
  const personal = menu.filter((item) => item.personal);
  const intoOrganization =
    area === "workspace" && accessTo("/settings/org", capabilities)?.allowed === true;

  return (
    <Stack sx={{ minHeight: 0, flexGrow: 1 }}>
      <Box
        sx={{
          height: 57,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          pl: 3,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography component="h1" variant="subtitle1" sx={{ fontWeight: 600 }}>
          {definition.title}
        </Typography>
      </Box>
      <Stack direction="row" sx={{ minHeight: 0, flexGrow: 1 }}>
        <Box
          component="nav"
          aria-label={definition.title}
          sx={{
            width: 240,
            flexShrink: 0,
            overflowY: "auto",
            borderRight: 1,
            borderColor: "divider",
            px: 2,
            pt: 2.5,
            pb: 2.5,
          }}
        >
          {area === "workspace" && (
            <Typography variant="overline" sx={{ color: "text.secondary", px: 2 }}>
              This workspace
            </Typography>
          )}
          <List dense sx={{ pb: 0, ...(area !== "workspace" && { pt: 0 }) }}>
            {own.map((item) => menuRow(item, pathname, null))}
          </List>
          {personal.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <List dense disablePadding>
                {personal.map((item) => menuRow(item, pathname, null))}
              </List>
            </>
          )}
          {intoOrganization && (
            <>
              <Divider sx={{ my: 2 }} />
              <List dense disablePadding>
                {menuRow(
                  { label: "Organization settings", path: "/settings/org" },
                  pathname,
                  <ChevronRight fontSize="small" sx={{ color: "text.secondary" }} />,
                )}
              </List>
            </>
          )}
        </Box>
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            overflowY: "auto",
            p: 3,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Outlet />
        </Box>
      </Stack>
    </Stack>
  );
}

function menuRow(item: { label: string; path: string }, pathname: string, trailing: ReactNode) {
  return (
    <ListItem key={item.path} disablePadding>
      <ListItemButton
        component={NavLink}
        to={item.path}
        selected={pathname === item.path || pathname.startsWith(`${item.path}/`)}
        sx={{ borderRadius: 1 }}
      >
        <ListItemText primary={item.label} />
        {trailing}
      </ListItemButton>
    </ListItem>
  );
}

/** An area opened without naming a page. After a workspace switch from a
 * settings page, that page; otherwise the page last open in the area. Either
 * only when this person may open it in this workspace, and the area's first
 * page when not, so a switch or a change of role never lands someone on a
 * page they cannot use. A page named in the URL is different: it shows why it
 * is refused (`Guarded`). */
export function SettingsIndex({ area }: { area: SettingsArea }) {
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
    candidates.find((path) => accessTo(path, capabilities)?.allowed === true) ??
    definition.first;
  return <Navigate to={landing} replace />;
}

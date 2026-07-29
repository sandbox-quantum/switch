import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import ChatBubbleOutlineOutlined from "@mui/icons-material/ChatBubbleOutlineOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PeopleOutlined from "@mui/icons-material/PeopleOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import VpnKeyOutlined from "@mui/icons-material/VpnKeyOutlined";
import { Box, Divider, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import { memo, useState } from "react";
import { NavLink, useLocation } from "react-router";
import type { ComponentType, MouseEvent } from "react";
import { useAuth } from "../data/AuthContext";
import ThemeModeToggle from "./ThemeModeToggle";

interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<{ sx?: object }>;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Ecosystem", path: "/ecosystem", icon: AccountTreeOutlined },
  { label: "Rooms", path: "/rooms", icon: MeetingRoomOutlined },
  { label: "Resources", path: "/resources", icon: FolderOutlined },
  { label: "Agents", path: "/agents", icon: SmartToyOutlined },
  { label: "Apps", path: "/collaborations", icon: ChatBubbleOutlineOutlined },
  { label: "API Keys", path: "/registration-keys", icon: VpnKeyOutlined },
];

const ADMIN_ITEMS: NavItem[] = [{ label: "Users", path: "/users", icon: PeopleOutlined }];

const TARGET = 44;
// The logo sits slightly inside the nav button footprint: it is a solid mark
// against thin-stroke icons, so matching the container would read as heavier.
const LOGO = 32;

function RailItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Box
      component={NavLink}
      to={item.path}
      aria-current={active ? "page" : undefined}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.5,
        textDecoration: "none",
        color: "text.primary",
        opacity: active ? 1 : 0.75,
        transition: "opacity 150ms",
        "&:hover": { opacity: 1 },
        "&:focus-visible": { outline: "2px solid var(--hoot-ring)", outlineOffset: 2, borderRadius: "16px" },
      }}
    >
      <Box
        sx={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: TARGET,
          height: TARGET,
          borderRadius: "16px",
          // The active indicator is a subtle vertical gradient pill with a
          // whisper of lift — never a filled accent.
          ...(active && {
            background: "linear-gradient(to bottom, var(--hoot-card), var(--hoot-secondary))",
            border: "1px solid var(--hoot-border)",
            boxShadow: "var(--hoot-shadow-rail-active)",
          }),
        }}
      >
        <item.icon sx={{ fontSize: 22, strokeWidth: 1.5 }} />
      </Box>
      <Typography
        sx={{ fontSize: "0.75rem", lineHeight: 1, fontWeight: 500, letterSpacing: "-0.01em" }}
      >
        {item.label}
      </Typography>
    </Box>
  );
}

export default memo(function NavRail() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const items = user?.role === "admin" ? [...NAV_ITEMS, ...ADMIN_ITEMS] : NAV_ITEMS;
  const initial = (user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <Stack
      component="aside"
      sx={{
        width: "var(--nav-rail-width)",
        flexShrink: 0,
        alignItems: "center",
        py: 2,
        color: "text.primary",
      }}
    >
      <Tooltip title="Switch Gateway" placement="right">
        {/* Two assets rather than one recoloured mark: the swap is done in CSS
            off the colour-scheme attribute so there is no flash on first paint,
            and a future coloured logo drops in without rework. The file names
            describe the ink — `dark` is the black mark, for the light theme. */}
        <Box
          sx={{
            width: TARGET,
            height: TARGET,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Box
            component="img"
            src="/switch_logo_dark.svg"
            alt="Switch"
            sx={{
              width: LOGO,
              height: LOGO,
              '[data-mui-color-scheme="dark"] &': { display: "none" },
            }}
          />
          <Box
            component="img"
            src="/switch_logo_light.svg"
            alt=""
            aria-hidden
            sx={{
              width: LOGO,
              height: LOGO,
              display: "none",
              '[data-mui-color-scheme="dark"] &': { display: "block" },
            }}
          />
        </Box>
      </Tooltip>

      <Divider sx={{ my: 2, width: 29 }} />

      <Stack sx={{ width: "100%", alignItems: "center", gap: 2 }}>
        {items.map((item) => (
          <RailItem
            key={item.path}
            item={item}
            active={location.pathname.startsWith(item.path)}
          />
        ))}
      </Stack>

      <Stack sx={{ mt: "auto", width: "100%", alignItems: "center", gap: 2, pt: 2 }}>
        <Box
          component="button"
          onClick={(e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)}
          aria-label="Account menu"
          sx={{
            width: TARGET,
            height: TARGET,
            borderRadius: "50%",
            border: "none",
            cursor: "pointer",
            backgroundColor: "primary.main",
            color: "primary.contrastText",
            fontFamily: "inherit",
            fontSize: "0.9375rem",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            "&:focus-visible": { outline: "2px solid var(--hoot-ring)", outlineOffset: 2 },
          }}
        >
          {initial}
        </Box>
      </Stack>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { width: 232, p: 0.5 } } }}
      >
        <Box sx={{ px: 1.5, py: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
            {user?.email}
          </Typography>
          {user?.role === "admin" && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Admin
            </Typography>
          )}
        </Box>
        <Divider sx={{ my: 0.5 }} />
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 1.5,
            py: 0.75,
          }}
        >
          <Typography variant="body2">Theme</Typography>
          <ThemeModeToggle />
        </Box>
        <Divider sx={{ my: 0.5 }} />
        <MenuItem onClick={logout} sx={{ gap: 1 }}>
          <LogoutOutlined sx={{ fontSize: 16 }} />
          Sign out
        </MenuItem>
      </Menu>
    </Stack>
  );
});

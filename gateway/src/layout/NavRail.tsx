import AddOutlined from "@mui/icons-material/AddOutlined";
import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import ChatBubbleOutlineOutlined from "@mui/icons-material/ChatBubbleOutlineOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import LockOutlined from "@mui/icons-material/LockOutlined";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import PeopleOutlined from "@mui/icons-material/PeopleOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import VpnKeyOutlined from "@mui/icons-material/VpnKeyOutlined";
import WorkspacesOutlined from "@mui/icons-material/WorkspacesOutlined";
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { memo, useState } from "react";
import { NavLink, useLocation } from "react-router";
import type { ComponentType, MouseEvent } from "react";
import { useAuth } from "../data/AuthContext";
import CreateWorkspaceForm from "../pages/onboarding/CreateWorkspaceForm";
import ChangePasswordDialog from "./ChangePasswordDialog";
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
  { label: "Workspace", path: "/workspace", icon: WorkspacesOutlined },
];

const ADMIN_ITEMS: NavItem[] = [{ label: "Users", path: "/users", icon: PeopleOutlined }];

const TARGET = 44;
// The logo sits slightly inside the nav button footprint: it is a solid mark
// against thin-stroke icons, so matching the container would read as heavier.
const LOGO = 28;

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
  const { user, session, isOperator, logout, switchTo } = useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const items = isOperator ? [...NAV_ITEMS, ...ADMIN_ITEMS] : NAV_ITEMS;
  const current = session?.tenant ?? null;
  const others = (session?.tenants ?? []).filter((t) => t.id !== current?.id);
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
          {isOperator && (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Operator
            </Typography>
          )}
        </Box>
        <Divider sx={{ my: 0.5 }} />
        <Box sx={{ px: 1.5, pt: 0.5, pb: 0.25 }}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Workspace
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
            {current?.name}
          </Typography>
        </Box>
        {others.map((tenant) => (
          <MenuItem
            key={tenant.id}
            onClick={() => {
              setAnchor(null);
              void switchTo(tenant.id);
            }}
          >
            <Typography variant="body2" noWrap>
              Switch to {tenant.name}
            </Typography>
          </MenuItem>
        ))}
        {session?.can_create_workspace && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setCreateOpen(true);
            }}
            sx={{ gap: 1 }}
          >
            <AddOutlined sx={{ fontSize: 16 }} />
            Create workspace
          </MenuItem>
        )}
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
        <MenuItem
          onClick={() => {
            setAnchor(null);
            setPasswordDialogOpen(true);
          }}
          sx={{ gap: 1 }}
        >
          <LockOutlined sx={{ fontSize: 16 }} />
          Change password
        </MenuItem>
        <MenuItem onClick={logout} sx={{ gap: 1 }}>
          <LogoutOutlined sx={{ fontSize: 16 }} />
          Sign out
        </MenuItem>
      </Menu>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Create a workspace</DialogTitle>
        <DialogContent sx={{ pt: "8px !important" }}>
          <CreateWorkspaceForm onCancel={() => setCreateOpen(false)} />
        </DialogContent>
      </Dialog>

      <ChangePasswordDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
      />
    </Stack>
  );
});

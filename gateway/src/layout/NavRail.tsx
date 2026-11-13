import AccountCircleOutlined from "@mui/icons-material/AccountCircleOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import LockOutlined from "@mui/icons-material/LockOutlined";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import {
  Alert,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { memo, useState } from "react";
import { NavLink, Link as RouterLink, useLocation } from "react-router";
import type { MouseEvent } from "react";
import { useAuth } from "../data/AuthContext";
import CreateWorkspaceForm from "../pages/onboarding/CreateWorkspaceForm";
import { type Layout, type RailItem as RailItemDefinition, railFor } from "../routes/routeTable";
import ChangePasswordDialog from "./ChangePasswordDialog";
import ThemeModeToggle from "./ThemeModeToggle";

// The rail follows the window's height: at a laptop's it is sized so an
// operator's eleven labelled items and the account button fit, and it grows
// with the window up to its full size. Shorter still, the items scroll.
const TARGET = "clamp(36px, 4vh, 44px)";
const ICON = "clamp(20px, 2.2vh, 22px)";
const ITEM_GAP = "clamp(4px, 1.4vh, 16px)";
const LABEL = "clamp(0.6875rem, 1.05vh, 0.75rem)";
// The logo sits slightly inside the nav button footprint: it is a solid mark
// against thin-stroke icons, so matching the container would read as heavier.
const LOGO = "clamp(24px, 2.6vh, 28px)";

function RailItem({ item, active }: { item: RailItemDefinition; active: boolean }) {
  return (
    <Box
      component={NavLink}
      to={item.to}
      aria-current={active ? "page" : undefined}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.25,
        textDecoration: "none",
        color: "text.primary",
        opacity: active ? 1 : 0.75,
        transition: "opacity 150ms",
        "&:hover": { opacity: 1 },
        "&:focus-visible": { outline: "2px solid var(--sw-ring)", outlineOffset: 2, borderRadius: "16px" },
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
          borderRadius: "12px",
          // The active indicator is a subtle vertical gradient pill with a
          // whisper of lift — never a filled accent.
          ...(active && {
            background: "linear-gradient(to bottom, var(--sw-card), var(--sw-secondary))",
            border: "1px solid var(--sw-border)",
            boxShadow: "var(--sw-shadow-rail-active)",
          }),
        }}
      >
        <item.icon sx={{ fontSize: ICON, strokeWidth: 1.5 }} />
      </Box>
      <Typography
        sx={{ fontSize: LABEL, lineHeight: 1, fontWeight: 500, letterSpacing: "-0.01em" }}
      >
        {item.label}
      </Typography>
    </Box>
  );
}

export default memo(function NavRail({ layout }: { layout: Layout }) {
  const location = useLocation();
  const { user, session, isOperator, capabilities, logout, logoutEverywhere, switchTo } =
    useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // What the menu last failed to do: switching workspace or signing out.
  const [menuError, setMenuError] = useState<string | null>(null);

  const switchWorkspace = async (tenantId: string) => {
    setAnchor(null);
    try {
      await switchTo(tenantId);
    } catch (err) {
      setMenuError(err instanceof Error ? err.message : "Could not switch workspace");
    }
  };

  // A sign-out that works leaves the dashboard; one that fails says so.
  const signOut = async (action: () => Promise<void>, failure: string) => {
    setAnchor(null);
    try {
      await action();
    } catch (err) {
      setMenuError(`${failure}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const items = railFor(layout, capabilities);
  const isActive = (item: RailItemDefinition) =>
    item.activeFor.some((prefix) => location.pathname.startsWith(prefix));
  const current = session?.tenant ?? null;
  // The new layout switches workspace from the top bar's breadcrumb.
  const others =
    layout === "v2" ? [] : (session?.tenants ?? []).filter((t) => t.id !== current?.id);
  const initial = (user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <Stack
      component="aside"
      sx={{
        width: "var(--nav-rail-width)",
        flexShrink: 0,
        minHeight: 0,
        alignItems: "center",
        py: 1.5,
        color: "text.primary",
      }}
    >
      <Tooltip title="Switch Gateway" placement="right">
        {/* Two assets rather than one recoloured mark: the swap is done in CSS
            off the colour-scheme attribute so there is no flash on first paint,
            and a future coloured logo drops in without rework. The file names
            describe the ink — `dark` is the black mark, for the light theme.
            An image, so the name the tooltip gives it is allowed on it. */}
        <Box
          role="img"
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

      <Divider sx={{ my: 1.5, width: 29 }} />

      <Stack component="nav" aria-label="Main" sx={{ width: "100%", flex: 1, minHeight: 0 }}>
        <Stack
          sx={{
            width: "100%",
            alignItems: "center",
            gap: ITEM_GAP,
            // On a window shorter still, the items scroll and the account
            // button stays put; the rail is too narrow for a scrollbar.
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {items
            .filter((item) => !item.bottom)
            .map((item) => (
              <RailItem key={item.to} item={item} active={isActive(item)} />
            ))}
        </Stack>
        {items.some((item) => item.bottom) && (
          <Stack sx={{ width: "100%", alignItems: "center", gap: ITEM_GAP, pt: 2 }}>
            {items
              .filter((item) => item.bottom)
              .map((item) => (
                <RailItem key={item.to} item={item} active={isActive(item)} />
              ))}
          </Stack>
        )}
      </Stack>

      <Stack sx={{ width: "100%", alignItems: "center", gap: 2, pt: 2 }}>
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
            "&:focus-visible": { outline: "2px solid var(--sw-ring)", outlineOffset: 2 },
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
              Platform operator
            </Typography>
          )}
        </Box>
        <Divider sx={{ my: 0.5 }} />
        {layout === "v2" ? (
          <MenuItem
            component={RouterLink}
            to="/settings/account"
            onClick={() => setAnchor(null)}
            sx={{ gap: 1 }}
          >
            <AccountCircleOutlined sx={{ fontSize: 16 }} />
            Your account
          </MenuItem>
        ) : (
          <Box sx={{ px: 1.5, pt: 0.5, pb: 0.25 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Workspace
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
              {current?.name}
            </Typography>
          </Box>
        )}
        {others.map((tenant) => (
          <MenuItem
            key={tenant.id}
            onClick={() => switchWorkspace(tenant.id)}
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
            Create organization
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
        {/* The new layout changes the password on Your account. */}
        {layout !== "v2" && (
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
        )}
        <MenuItem onClick={() => signOut(logout, "Could not sign out")} sx={{ gap: 1 }}>
          <LogoutOutlined sx={{ fontSize: 16 }} />
          Sign out
        </MenuItem>
        <MenuItem
          onClick={() => signOut(logoutEverywhere, "Could not sign out of every device")}
          sx={{ gap: 1 }}
        >
          <LogoutOutlined sx={{ fontSize: 16 }} />
          Sign out of all devices
        </MenuItem>
      </Menu>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Create an organization</DialogTitle>
        <DialogContent sx={{ pt: "8px !important" }}>
          <CreateWorkspaceForm onCancel={() => setCreateOpen(false)} />
        </DialogContent>
      </Dialog>

      <Snackbar
        open={menuError !== null}
        onClose={() => setMenuError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Alert severity="error" onClose={() => setMenuError(null)}>
          {menuError}
        </Alert>
      </Snackbar>

      <ChangePasswordDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
      />
    </Stack>
  );
});

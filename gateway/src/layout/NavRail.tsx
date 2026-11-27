import AccountCircleOutlined from "@mui/icons-material/AccountCircleOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
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
  Typography,
} from "@mui/material";
import { memo, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import type { MouseEvent } from "react";
import { useAuth } from "../data/AuthContext";
import CreateWorkspaceForm from "../pages/onboarding/CreateWorkspaceForm";
import { type RailItem as RailItemDefinition, railFor } from "../routes/routeTable";
import ThemeModeToggle from "./ThemeModeToggle";

// The rail follows the window's height: at a laptop's it is sized so an
// operator's eleven labelled items and the account button fit, and it grows
// with the window up to its full size. Shorter still, the items scroll.
const TARGET = "clamp(36px, 4vh, 44px)";
const ICON = "clamp(20px, 2.2vh, 22px)";
const ITEM_GAP = "clamp(4px, 1.4vh, 16px)";
const LABEL = "clamp(0.6875rem, 1.05vh, 0.75rem)";

function RailItem({ item, active }: { item: RailItemDefinition; active: boolean }) {
  return (
    // A plain link: NavLink would set aria-current from its own match, which
    // misses the paths an item also stands for (`activeFor`).
    <Box
      component={RouterLink}
      to={item.to}
      aria-current={active ? "page" : undefined}
      aria-label={item.labelled ? undefined : item.label}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.25,
        textDecoration: "none",
        color: "text.primary",
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
      {item.labelled && (
        <Typography
          sx={{ fontSize: LABEL, lineHeight: 1, fontWeight: 500, letterSpacing: "-0.01em" }}
        >
          {item.label}
        </Typography>
      )}
    </Box>
  );
}

/** What the account button shows: the initials of the first and last words
 * of the person's name, or the first letter of their email when the name
 * gives none. */
export function accountInitials(user: { name: string; email: string } | null): string {
  const words = (user?.name ?? "").split(/\s+/).filter((word) => /^\p{L}/u.test(word));
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  const initials = picked.map((word) => Array.from(word)[0]).join("");
  return (initials === "" ? (user?.email ?? "?").charAt(0) : initials).toLocaleUpperCase();
}

export default memo(function NavRail() {
  const location = useLocation();
  const { user, session, isOperator, capabilities, logout, logoutEverywhere } = useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // What the menu last failed to do: signing out.
  const [menuError, setMenuError] = useState<string | null>(null);

  // A sign-out that works leaves the dashboard; one that fails says so.
  const signOut = async (action: () => Promise<void>, failure: string) => {
    setAnchor(null);
    try {
      await action();
    } catch (err) {
      setMenuError(`${failure}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const items = railFor(capabilities);
  const isActive = (item: RailItemDefinition) =>
    item.activeFor.some((prefix) => location.pathname.startsWith(prefix));
  const initials = accountInitials(user);

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
          {initials}
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
        <MenuItem
          component={RouterLink}
          to="/settings/account"
          onClick={() => setAnchor(null)}
          sx={{ gap: 1 }}
        >
          <AccountCircleOutlined sx={{ fontSize: 16 }} />
          Your account
        </MenuItem>
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
        <MenuItem onClick={() => signOut(logout, "Couldn't sign out")} sx={{ gap: 1 }}>
          <LogoutOutlined sx={{ fontSize: 16 }} />
          Sign out
        </MenuItem>
        <MenuItem
          onClick={() => signOut(logoutEverywhere, "Couldn't sign out of every device")}
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
    </Stack>
  );
});
